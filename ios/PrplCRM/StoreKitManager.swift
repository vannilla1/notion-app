import StoreKit
import Foundation

/// StoreKit 2 manager pre Apple In-App Purchases.
///
/// Architektúra (Option B): native vrstva robí iba StoreKit nákup a vráti
/// JWS (signed transaction) webu cez bridge callback. Web potom POSTne JWS na
/// /api/billing/apple/verify cez svoj api client (reuse token + refresh +
/// error handling). Backend + App Store Server Notifications V2 sú zdroj
/// pravdy pre renewal / expiry / refund.
///
/// Product IDs sa MUSIA zhodovať so server/config/appleProducts.js.
final class StoreKitManager {
    static let shared = StoreKitManager()

    // Pozor: rovnaké stringy ako server/config/appleProducts.js
    let productIds = [
        "prplcrm.team.monthly",
        "prplcrm.team.yearly",
        "prplcrm.pro.monthly",
        "prplcrm.pro.yearly"
    ]

    private(set) var products: [Product] = []
    private var updateListenerTask: Task<Void, Never>?

    /// Callback keď príde transakcia MIMO priameho nákupu (auto-renewal,
    /// Ask to Buy approval, restore na inom zariadení). Web sa o renewals
    /// dozvie aj cez ASSN webhook (zdroj pravdy), takže toto je primárne na
    /// finish() transakcie + voliteľný UI refresh. Callback môže byť volaný
    /// z background kontextu — consumer musí dispatchnúť na main pri práci
    /// s WKWebView.
    var onExternalTransaction: ((String) -> Void)?

    private init() {
        // Listener pre transakcie ktoré prídu mimo priameho purchase().
        updateListenerTask = listenForTransactions()
    }

    deinit {
        updateListenerTask?.cancel()
    }

    /// Načítaj produkty z App Store (lazy — pri prvom dotaze).
    func loadProducts() async {
        do {
            let fetched = try await Product.products(for: productIds)
            self.products = fetched
            NSLog("[StoreKit] Loaded \(fetched.count) products")
        } catch {
            NSLog("[StoreKit] loadProducts error: \(error.localizedDescription)")
            NativeErrorReporter.report(name: "iOSStoreKitLoadProductsFailed", message: error.localizedDescription, url: "https://prplcrm.eu/native/iap")
        }
    }

    /// Produkty ako JSON-friendly pole pre injekt do web UI (cena je
    /// lokalizovaná podľa App Store regiónu používateľa).
    func productsForWeb() async -> [[String: Any]] {
        if products.isEmpty { await loadProducts() }
        return products.map { p in
            [
                "productId": p.id,
                "displayName": p.displayName,
                "description": p.description,
                "price": p.displayPrice,                              // napr. "9,99 €"
                "priceValue": (p.price as NSDecimalNumber).doubleValue
            ]
        }
    }

    enum PurchaseOutcome {
        case success(jws: String)
        case userCancelled
        case pending          // Ask to Buy / SCA — výsledok príde cez listener
        case failed(message: String)
    }

    /// Spustí StoreKit nákup pre productId. Vráti JWS pri úspechu —
    /// web ho pošle backendu na overenie.
    func purchase(productId: String) async -> PurchaseOutcome {
        if products.isEmpty { await loadProducts() }
        guard let product = products.first(where: { $0.id == productId }) else {
            return .failed(message: "Produkt nenájdený")
        }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                // jwsRepresentation je dostupné aj keď je .unverified —
                // ale my finish-neme + akceptujeme len .verified.
                if case .verified(let transaction) = verification {
                    let jws = verification.jwsRepresentation
                    await transaction.finish()
                    return .success(jws: jws)
                } else {
                    NativeErrorReporter.report(name: "iOSStoreKitVerificationFailed", message: "Purchase result .unverified pre \(productId)", url: "https://prplcrm.eu/native/iap")
                    return .failed(message: "Overenie transakcie zlyhalo")
                }
            case .userCancelled:
                return .userCancelled
            case .pending:
                return .pending
            @unknown default:
                return .failed(message: "Neznámy výsledok nákupu")
            }
        } catch {
            NativeErrorReporter.report(name: "iOSStoreKitPurchaseFailed", message: "\(productId): \(error.localizedDescription)", url: "https://prplcrm.eu/native/iap")
            return .failed(message: error.localizedDescription)
        }
    }

    /// Obnova nákupov — pre prípad reinštalácie / nového zariadenia.
    /// StoreKit 2: currentEntitlements obsahuje aktívne subscriptions.
    /// Vráti JWS najnovšej aktívnej subscription (alebo nil).
    func restorePurchases() async -> String? {
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result {
                // Vráť prvú aktívnu auto-renewable subscription
                if transaction.productType == .autoRenewable {
                    return result.jwsRepresentation
                }
            }
        }
        return nil
    }

    /// Listener pre transakcie mimo priameho purchase() (renewals, Ask to Buy
    /// approval, restore). Finish-ne ich a notifikuje web cez callback.
    private func listenForTransactions() -> Task<Void, Never> {
        return Task { [weak self] in
            for await result in Transaction.updates {
                if case .verified(let transaction) = result {
                    let jws = result.jwsRepresentation
                    await transaction.finish()
                    self?.onExternalTransaction?(jws)
                }
            }
        }
    }
}
