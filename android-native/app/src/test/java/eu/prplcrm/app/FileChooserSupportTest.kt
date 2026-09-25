package eu.prplcrm.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Date
import java.util.TimeZone

class FileChooserSupportTest {

    @get:Rule
    val tmp = TemporaryFolder()

    // Náhrada MimeTypeMap (android.* v JVM testoch nie je).
    private val mimes = mapOf(
        "pdf" to "application/pdf",
        "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "txt" to "text/plain",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg"
    )
    private val lookup: (String) -> String? = { mimes[it] }

    private fun spec(vararg accept: String, capture: Boolean = false) =
        FileChooserSupport.buildSpec(arrayOf(*accept), capture, lookup)

    @Test
    fun `bez accept (WebView posle jeden prazdny retazec) = vsetky subory + fotka aj video`() {
        val s = spec("")
        assertEquals(emptyList<String>(), s.mimeTypes)
        assertTrue(s.offerPhoto)
        assertTrue(s.offerVideo)
        assertFalse(s.imagesOnly)
    }

    @Test
    fun `spravy (accept bez videa) = fotka ano, video nie, filter bez video typov`() {
        // Historický scenár: správy do 9/2026 video neprijímali a Messages.jsx
        // posielal accept bez video typov. Dnes prílohy správ žijú v R2, accept
        // sa nenastavuje a video je povolené — test ostáva ako čistý buildSpec
        // test pre accept bez videa.
        val s = spec("image/*", "application/*", "text/*", "audio/*", "message/*")
        assertTrue(s.offerPhoto)
        assertFalse(s.offerVideo)
        assertEquals(listOf("image/*", "application/*", "text/*", "audio/*", "message/*"), s.mimeTypes)
    }

    @Test
    fun `null accept sa sprava ako prazdny`() {
        val s = FileChooserSupport.buildSpec(null, false, lookup)
        assertEquals(emptyList<String>(), s.mimeTypes)
        assertTrue(s.offerPhoto)
        assertTrue(s.offerVideo)
    }

    @Test
    fun `profilova fotka image-star = len fotka, bez videa`() {
        val s = spec("image/*")
        assertEquals(listOf("image/*"), s.mimeTypes)
        assertTrue(s.offerPhoto)
        assertFalse(s.offerVideo)
        assertTrue(s.imagesOnly)
    }

    @Test
    fun `ContactDetail accept s priponami sa prelozi na MIME typy`() {
        val s = spec("image/*", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt")
        assertEquals(
            listOf(
                "image/*",
                "application/pdf",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.ms-excel",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "text/plain"
            ),
            s.mimeTypes
        )
        assertTrue(s.offerPhoto)
        assertFalse(s.offerVideo)
        assertFalse(s.imagesOnly)
    }

    @Test
    fun `len dokumenty = bez fotoaparatu`() {
        val s = spec(".pdf")
        assertEquals(listOf("application/pdf"), s.mimeTypes)
        assertFalse(s.offerPhoto)
        assertFalse(s.offerVideo)
    }

    @Test
    fun `neznama pripona = bez filtra, aby sa subor dal vybrat`() {
        val s = spec(".pdf", ".neznama")
        assertEquals(emptyList<String>(), s.mimeTypes)
        assertFalse(s.offerPhoto)
        assertFalse(s.offerVideo)
    }

    @Test
    fun `video accept = len video`() {
        val s = spec("video/mp4")
        assertEquals(listOf("video/mp4"), s.mimeTypes)
        assertFalse(s.offerPhoto)
        assertTrue(s.offerVideo)
    }

    @Test
    fun `hviezdicka = vsetko`() {
        val s = spec("*/*")
        assertEquals(emptyList<String>(), s.mimeTypes)
        assertTrue(s.offerPhoto)
        assertTrue(s.offerVideo)
    }

    @Test
    fun `capture bez image-video accept ponukne aspon fotku`() {
        val s = spec("application/pdf", capture = true)
        assertTrue(s.offerPhoto)
        assertFalse(s.offerVideo)
    }

    @Test
    fun `medzery, velke pismena a duplicity sa normalizuju`() {
        val s = spec(" IMAGE/JPEG ", ".JPG", ".jpeg", "")
        assertEquals(listOf("image/jpeg"), s.mimeTypes)
        assertTrue(s.imagesOnly)
    }

    @Test
    fun `nazov zaberu ma priponu podla druhu`() {
        val date = Date(1_790_266_500_000L) // 2026-09-24 16:15:00 UTC
        val utc = TimeZone.getTimeZone("UTC")
        assertEquals("IMG_20260924_161500.jpg", FileChooserSupport.captureFileName(CaptureKind.PHOTO, date, utc))
        assertEquals("VID_20260924_161500.mp4", FileChooserSupport.captureFileName(CaptureKind.VIDEO, date, utc))
        assertEquals("IMG_20260924_161500_2.jpg", FileChooserSupport.captureFileName(CaptureKind.PHOTO, date, utc, 2))
    }

    @Test
    fun `dva zabery v tej istej sekunde dostanu rozne subory`() {
        val dir = File(tmp.root, FileChooserSupport.CAPTURES_DIR) // ešte neexistuje
        val date = Date(1_790_266_500_000L)
        val utc = TimeZone.getTimeZone("UTC")
        val first = FileChooserSupport.newCaptureFile(dir, CaptureKind.PHOTO, date, utc)
        val second = FileChooserSupport.newCaptureFile(dir, CaptureKind.PHOTO, date, utc)
        assertTrue(first.exists())
        assertTrue(second.exists())
        assertNotEquals(first, second)
        assertEquals("IMG_20260924_161500.jpg", first.name)
        assertEquals("IMG_20260924_161500_2.jpg", second.name)
        assertEquals(0L, first.length())
    }

    @Test
    fun `stare zabery sa zmazu, cerstve ostanu`() {
        val dir = tmp.newFolder(FileChooserSupport.CAPTURES_DIR)
        val now = 1_790_266_500_000L
        val old = File(dir, "IMG_old.jpg").apply { writeText("x"); setLastModified(now - FileChooserSupport.CAPTURE_MAX_AGE_MS - 1000) }
        val fresh = File(dir, "IMG_new.jpg").apply { writeText("x"); setLastModified(now - 1000) }
        assertEquals(1, FileChooserSupport.deleteStaleCaptures(dir, now))
        assertFalse(old.exists())
        assertTrue(fresh.exists())
    }

    @Test
    fun `cistenie neexistujuceho priecinka nespadne`() {
        assertEquals(0, FileChooserSupport.deleteStaleCaptures(File(tmp.root, "neexistuje"), System.currentTimeMillis()))
    }
}
