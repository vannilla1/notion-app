const User = require('../models/User');
const FcmDevice = require('../models/FcmDevice');
const APNsDevice = require('../models/APNsDevice');
const logger = require('../utils/logger');

/**
 * Universal announcement infraštruktúra. Definuje content + visibility pravidlá
 * pre in-app oznamovacie pily/bannery ("Mobilná appka teraz dostupná",
 * "Nový feature XY", atď.).
 *
 * Definícia announcementu má 3 zložky:
 *  - content (title, message, icon, CTA-čka)
 *  - active range (od kedy do kedy sa môže ukázať)
 *  - hideRules (per-user podmienky kedy sa NIKDY neukáže — napr. už má appku
 *    nainštalovanú, alebo manually dismissol)
 *
 * Frontend volá `GET /api/announcements/active` a backend mu vráti len tie
 * announcements ktoré má **aktuálne** vidieť. Manual dismiss cez
 * `POST /api/announcements/:id/dismiss`.
 *
 * Pre nový announcement v budúcnosti stačí pridať záznam do ANNOUNCEMENTS
 * objektu — žiadny migration script, žiadne schema zmeny.
 */

const ANNOUNCEMENTS = {
  /**
   * v1 — Mobilná appka prvý launch (Android live na Google Play, iOS pending
   * Apple review). Po iOS schválení vytvoríme `mobile_app_v2` ktorý sa
   * automaticky prejaví aj userom čo dismissli v1 (lebo flag je per verzia).
   */
  mobile_app_v1: {
    id: 'mobile_app_v1',
    icon: '📱',
    pillLabel: 'Nové: Mobilná appka',
    title: 'Mobilná aplikácia je tu',
    body: 'Prpl CRM si stiahnete na Android-e cez Google Play už dnes. iOS verzia prechádza posledným kolom Apple App Store review a bude k dispozícii v najbližších dňoch.',
    cta: {
      googlePlay: {
        label: 'Stiahnuť na Google Play',
        url: 'https://play.google.com/store/apps/details?id=eu.prplcrm.app',
        active: true
      },
      appStore: {
        label: 'Pripravujeme — App Store',
        url: null,
        active: false
      }
    },
    activeFrom: new Date('2026-05-06T00:00:00Z'),
    activeUntil: null,
    // Hide if user has any mobile app device registered (FCM = Android, APNs = iOS).
    // Token sa registruje pri prvom login-e v natívnej appke, tým pádom je to
    // spoľahlivý signál že user appku reálne má (nie len klikol na banner).
    hideIfHasMobileApp: true
  }
};

const getAllAnnouncements = () => Object.values(ANNOUNCEMENTS);

/**
 * Vráti zoznam announcementov ktoré má daný user aktuálne vidieť. Logika:
 *  1. announcement musí byť v active range
 *  2. user ho ešte nedismissol (žiadny záznam v dismissedAnnouncements[id])
 *  3. ak hideIfHasMobileApp=true, user nesmie mať FCM ani APNs device
 */
const getActiveAnnouncementsForUser = async (userId) => {
  if (!userId) return [];

  const user = await User.findById(userId).select('preferences').lean();
  if (!user) return [];

  const dismissed = user.preferences?.dismissedAnnouncements || {};
  const dismissedKeys = dismissed instanceof Map
    ? Array.from(dismissed.keys())
    : Object.keys(dismissed);

  const now = new Date();
  const candidates = getAllAnnouncements().filter((a) => {
    // Active range
    if (a.activeFrom && now < a.activeFrom) return false;
    if (a.activeUntil && now > a.activeUntil) return false;
    // Manual dismiss
    if (dismissedKeys.includes(a.id)) return false;
    return true;
  });

  // Pre announcements s hideIfHasMobileApp lookupneme device tabuľky raz,
  // nie per-announcement (optimization keď ich bude viac).
  const needsMobileCheck = candidates.some((a) => a.hideIfHasMobileApp);
  let hasMobileApp = false;
  if (needsMobileCheck) {
    const [fcmCount, apnsCount] = await Promise.all([
      FcmDevice.countDocuments({ userId }),
      APNsDevice.countDocuments({ userId })
    ]);
    hasMobileApp = fcmCount > 0 || apnsCount > 0;
  }

  return candidates
    .filter((a) => !a.hideIfHasMobileApp || !hasMobileApp)
    // Strip internal fields, return UI-friendly shape
    .map((a) => ({
      id: a.id,
      icon: a.icon,
      pillLabel: a.pillLabel,
      title: a.title,
      body: a.body,
      cta: a.cta
    }));
};

const dismissAnnouncement = async (userId, announcementId) => {
  if (!ANNOUNCEMENTS[announcementId]) {
    return { ok: false, error: 'Unknown announcement' };
  }
  await User.updateOne(
    { _id: userId },
    { $set: { [`preferences.dismissedAnnouncements.${announcementId}`]: new Date() } }
  );
  return { ok: true };
};

module.exports = {
  ANNOUNCEMENTS,
  getAllAnnouncements,
  getActiveAnnouncementsForUser,
  dismissAnnouncement
};
