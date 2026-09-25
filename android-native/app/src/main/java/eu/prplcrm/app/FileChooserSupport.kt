package eu.prplcrm.app

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Druh záznamu z fotoaparátu — určuje prefix a príponu dočasného súboru. */
enum class CaptureKind(val prefix: String, val extension: String) {
    PHOTO("IMG", "jpg"),
    VIDEO("VID", "mp4")
}

/**
 * Rozhodovanie pre `<input type="file">` vo WebView (MainActivity.onShowFileChooser).
 *
 * Čistý Kotlin (bez android.* tried), aby bol testovateľný v JVM unit testoch —
 * rovnako ako JwtUtils. MimeTypeMap sa sem podáva ako funkcia zvonku.
 *
 * Prečo to vôbec existuje: shell doteraz otváral LEN systémový výber súborov
 * (ACTION_OPEN_DOCUMENT), ktorý nemá položku Fotoaparát — na Androide sa
 * príloha nedala odfotiť priamo z appky (iOS WKWebView aj Chrome to ponúkajú).
 */
object FileChooserSupport {

    /** Podpriečinok v cacheDir — MUSÍ sedieť s res/xml/file_paths.xml (cache-path "captures/"). */
    const val CAPTURES_DIR = "captures"

    /**
     * Po akom čase sa staré zábery mažú pri štarte. Nemažeme hneď po odovzdaní
     * WebView — web si súbor číta až pri zaradení do fronty / odoslaní, takže
     * okamžité zmazanie by nahrávanie rozbilo. Deň je bezpečná rezerva; systém
     * navyše cacheDir čistí sám pri nedostatku miesta.
     */
    const val CAPTURE_MAX_AGE_MS = 24L * 60 * 60 * 1000

    data class Spec(
        /** MIME typy pre výber súborov; prázdny zoznam = bez filtra (všetky súbory). */
        val mimeTypes: List<String>,
        /** Ponúknuť „Odfotiť". */
        val offerPhoto: Boolean,
        /** Ponúknuť „Nahrať video". */
        val offerVideo: Boolean
    ) {
        /** Input prijíma len obrázky (napr. profilová fotka) — mení sa len titulok dialógu. */
        val imagesOnly: Boolean
            get() = mimeTypes.isNotEmpty() && mimeTypes.all { it.startsWith("image/") }
    }

    /**
     * @param acceptTypes `FileChooserParams.acceptTypes` — WebView pošle hodnoty
     *   z HTML `accept` bez úprav: MIME typy (napr. „image/jpeg") AJ prípony („.pdf").
     *   Bez `accept` atribútu príde pole s jedným prázdnym reťazcom.
     * @param captureEnabled `FileChooserParams.isCaptureEnabled` (HTML `capture`).
     * @param mimeForExtension prípona bez bodky → MIME typ (MimeTypeMap), null = neznáma.
     */
    fun buildSpec(
        acceptTypes: Array<String>?,
        captureEnabled: Boolean,
        mimeForExtension: (String) -> String?
    ): Spec {
        val raw = acceptTypes
            ?.map { it.trim().lowercase(Locale.ROOT) }
            ?.filter { it.isNotEmpty() }
            .orEmpty()

        // Prípony sa MUSIA preložiť na MIME typy — DocumentsUI porovnáva
        // EXTRA_MIME_TYPES len s MIME typmi, takže „.pdf" by PDF-ká zošedilo
        // a nedali by sa vybrať (ContactDetail má accept s príponami).
        var anyUnknown = false
        val known = raw.mapNotNull { type ->
            val mime = if (type.contains('/')) type
            else mimeForExtension(type.removePrefix("."))?.lowercase(Locale.ROOT)
            if (mime == null) anyUnknown = true
            mime
        }.distinct()

        val anyType = raw.isEmpty() || known.contains(WILDCARD)
        var offerPhoto = anyType || known.any { it.startsWith("image/") }
        val offerVideo = anyType || known.any { it.startsWith("video/") }
        // `capture` bez image/video accept je nezvyčajné, ale web tým jasne
        // žiada fotoaparát — ponúkneme aspoň fotku.
        if (captureEnabled && !offerPhoto && !offerVideo) offerPhoto = true

        // Neznáma prípona → radšej bez filtra, než aby user nevedel vybrať
        // súbor, ktorý web výslovne povoľuje (server si typ overí sám).
        val mimeTypes = if (anyType || anyUnknown) emptyList() else known
        return Spec(mimeTypes, offerPhoto, offerVideo)
    }

    /** Napr. IMG_20260924_181500.jpg — prípona je dôležitá, server podľa nej filtruje typ. */
    fun captureFileName(
        kind: CaptureKind,
        now: Date,
        timeZone: TimeZone = TimeZone.getDefault(),
        suffix: Int = 1
    ): String {
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
            .apply { this.timeZone = timeZone }
            .format(now)
        val unique = if (suffix > 1) "_$suffix" else ""
        return "${kind.prefix}_$stamp$unique.${kind.extension}"
    }

    /**
     * Vytvorí prázdny súbor pre fotoaparát. Názov je vždy nový — dva zábery
     * v tej istej sekunde by si inak prepísali obsah a prvý (ešte nenahraný)
     * by sa odoslal s dátami druhého.
     */
    fun newCaptureFile(
        dir: File,
        kind: CaptureKind,
        now: Date,
        timeZone: TimeZone = TimeZone.getDefault()
    ): File {
        if (!dir.isDirectory && !dir.mkdirs()) {
            throw java.io.IOException("Nepodarilo sa vytvoriť priečinok pre zábery")
        }
        for (suffix in 1..MAX_NAME_ATTEMPTS) {
            val file = File(dir, captureFileName(kind, now, timeZone, suffix))
            if (file.createNewFile()) return file
        }
        throw java.io.IOException("Nepodarilo sa vytvoriť súbor pre záber")
    }

    /** Zmaže zábery staršie ako [maxAgeMs]. Vráti počet zmazaných súborov. */
    fun deleteStaleCaptures(dir: File, nowMs: Long, maxAgeMs: Long = CAPTURE_MAX_AGE_MS): Int {
        val files = dir.listFiles() ?: return 0
        var deleted = 0
        for (file in files) {
            if (file.isFile && nowMs - file.lastModified() > maxAgeMs && file.delete()) deleted++
        }
        return deleted
    }

    private const val WILDCARD = "*/*"
    private const val MAX_NAME_ATTEMPTS = 100
}
