import Foundation
import Security

/// Simple Keychain wrapper for storing auth token securely
struct KeychainHelper {
    private static let service = "sk.perunelectromobility.prplcrm"
    private static let tokenAccount = "authToken"

    /// Save auth token to Keychain
    static func saveToken(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }

        // Delete existing first
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Add new
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecSuccess {
            debugLog("[Keychain] Token saved successfully")
        } else {
            debugLog("[Keychain] Save failed: \(status)")
        }
    }

    /// Retrieve auth token from Keychain
    static func getToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /// Delete auth token from Keychain (on logout)
    static func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
        let status = SecItemDelete(query as CFDictionary)
        debugLog("[Keychain] Token deleted: \(status == errSecSuccess ? "OK" : "status \(status)")")
    }
}
