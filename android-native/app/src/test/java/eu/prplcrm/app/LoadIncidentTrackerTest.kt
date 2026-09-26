package eu.prplcrm.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadIncidentTrackerTest {

    private var clock = 1_000L
    private val tracker = LoadIncidentTracker(now = { clock }, reportAfterMs = 60_000)
    private val http504 = LoadIncidentTracker.Failure("status=504 url=https://prplcrm.eu/app", "https://prplcrm.eu/app")
    private val timeout = LoadIncidentTracker.Failure("code=-8 desc=net::ERR_TIMED_OUT url=https://prplcrm.eu/app", "https://prplcrm.eu/app")

    @Test
    fun `kratky vypadok vyrieseny opakovanim sa nehlasi`() {
        assertTrue(tracker.onFailure(http504, online = true))
        clock += 3_000
        assertNull(tracker.takeDueReport())
        assertEquals(3_000L, tracker.onSuccess())
        clock += 120_000
        assertNull(tracker.takeDueReport())
        assertFalse(tracker.isOpen)
    }

    @Test
    fun `vypadok dlhsi ako limit sa nahlasi prave raz`() {
        tracker.onFailure(http504, online = true)
        clock += 30_000
        assertFalse(tracker.onFailure(timeout, online = true))
        assertEquals(30_000L, tracker.msUntilDue())
        clock += 30_000
        val report = tracker.takeDueReport()
        assertNotNull(report)
        assertEquals(http504, report!!.failure)
        assertEquals(2, report.attempts)
        assertEquals(0, report.offlineAttempts)
        assertEquals(60_000L, report.durationMs)
        assertNull(tracker.takeDueReport())
        assertNull(tracker.msUntilDue())
    }

    @Test
    fun `vypadok len bez siete sa nehlasi`() {
        assertFalse(tracker.onFailure(timeout, online = false))
        assertNull(tracker.msUntilDue())
        clock += 90_000
        tracker.onFailure(timeout, online = false)
        assertNull(tracker.takeDueReport())
    }

    @Test
    fun `cas bez siete sa nepocita - prvy pokus po navrate siete sa nehlasi hned`() {
        tracker.onFailure(timeout, online = false)
        clock += 70_000
        // Sieť sa vrátila, prvý pokus zlyhá pri nadväzovaní spojenia.
        assertTrue(tracker.onFailure(timeout, online = true))
        assertNull(tracker.takeDueReport())
        assertEquals(60_000L, tracker.msUntilDue())
        clock += 5_000
        assertEquals(5_000L, tracker.onSuccess())
    }

    @Test
    fun `offline zaciatok a potom dlhy vypadok servera sa nahlasi minutu po prvom zlyhani so sietou`() {
        tracker.onFailure(timeout, online = false)
        clock += 70_000
        tracker.onFailure(http504, online = true)
        clock += 59_000
        assertNull(tracker.takeDueReport())
        clock += 1_000
        tracker.onFailure(http504, online = true)
        val report = tracker.takeDueReport()
        assertNotNull(report)
        assertEquals(http504, report!!.failure)
        assertEquals(3, report.attempts)
        assertEquals(1, report.offlineAttempts)
        assertEquals(60_000L, report.durationMs)
    }

    @Test
    fun `po uspechu zacne novy vypadok od nuly a vie ze stranka uz bezala`() {
        tracker.onFailure(http504, online = true)
        clock += 2_000
        tracker.onSuccess()
        clock += 600_000
        assertTrue(tracker.onFailure(timeout, online = true))
        clock += 60_000
        val report = tracker.takeDueReport()
        assertNotNull(report)
        assertEquals(timeout, report!!.failure)
        assertEquals(1, report.attempts)
        assertTrue(report.loadedBefore)
    }

    @Test
    fun `studeny start bez uspesneho nacitania`() {
        tracker.onFailure(http504, online = true)
        clock += 60_000
        assertFalse(tracker.takeDueReport()!!.loadedBefore)
    }

    @Test
    fun `uspech bez vypadku nic nevrati`() {
        assertNull(tracker.onSuccess())
        assertNull(tracker.msUntilDue())
    }
}
