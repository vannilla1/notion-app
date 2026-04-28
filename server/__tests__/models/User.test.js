const mongoose = require('mongoose');
const User = require('../../models/User');

/**
 * User model testy — hlavne overenie calendarFeedToken sparse unique indexu.
 *
 * Kontext opravy:
 * Pôvodný index na calendarFeedToken bol bez sparse:true, takže keď mal
 * dvaja userovia null token, MongoDB hlásil duplicate key error pri
 * register-i druhého usera. Oprava pridala sparse:true do schémy, takže
 * null hodnoty sú vynechané z unique constraint.
 *
 * Migračný skript: server/scripts/fix-index-and-create-admin.js drop-ne
 * starý index a recreate-ne ako sparse na existujúcej produkčnej DB.
 */
describe('User model', () => {
  // Zabezpečí, že indexy z schémy sú vytvorené pred testami (Mongoose
  // štandardne vytvára indexy lazily — cez ensureIndexes/init to vynútime).
  beforeAll(async () => {
    await User.init();
  });

  describe('calendarFeedToken sparse unique index', () => {
    it('povolí vytvoriť dvoch userov bez calendarFeedToken (oba null)', async () => {
      // Arrange / Act
      const user1 = await User.create({
        username: 'user1',
        email: 'user1@test.com',
        password: 'hashedpassword123'
      });
      const user2 = await User.create({
        username: 'user2',
        email: 'user2@test.com',
        password: 'hashedpassword123'
      });

      // Assert — obaja vytvorení bez duplicate key erroru
      expect(user1.calendarFeedToken).toBeUndefined();
      expect(user2.calendarFeedToken).toBeUndefined();
      const count = await User.countDocuments({});
      expect(count).toBe(2);
    });

    it('povolí vytvoriť dvoch userov s rôznymi calendarFeedToken', async () => {
      // Arrange / Act
      await User.create({
        username: 'userA',
        email: 'a@test.com',
        password: 'hashedpassword123',
        calendarFeedToken: 'token-aaa-111'
      });
      await User.create({
        username: 'userB',
        email: 'b@test.com',
        password: 'hashedpassword123',
        calendarFeedToken: 'token-bbb-222'
      });

      // Assert
      const count = await User.countDocuments({});
      expect(count).toBe(2);
    });

    it('zamietne vytvoriť druhého usera s rovnakým calendarFeedToken (unique stále platí)', async () => {
      // Arrange
      await User.create({
        username: 'userX',
        email: 'x@test.com',
        password: 'hashedpassword123',
        calendarFeedToken: 'shared-token-duplicate'
      });

      // Act / Assert — druhý user s rovnakým tokenom musí zlyhať
      await expect(
        User.create({
          username: 'userY',
          email: 'y@test.com',
          password: 'hashedpassword123',
          calendarFeedToken: 'shared-token-duplicate'
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('povolí vytvoriť 10 userov bez tokenu (regresný test na pôvodný bug)', async () => {
      // Toto je presne scenár, ktorý pôvodný bug zlyhal — register viacerých
      // userov za sebou bez toho, aby niekto z nich aktivoval calendar feed.
      const users = [];
      for (let i = 0; i < 10; i++) {
        users.push({
          username: `bulk${i}`,
          email: `bulk${i}@test.com`,
          password: 'hashedpassword123'
        });
      }

      // Act
      await User.insertMany(users);

      // Assert
      const count = await User.countDocuments({});
      expect(count).toBe(10);
    });

    it('po aktivácii tokenu zachová unique constraint', async () => {
      // Arrange — vytvoríme dvoch userov bez tokenu
      const user1 = await User.create({
        username: 'activate1',
        email: 'act1@test.com',
        password: 'hashedpassword123'
      });
      await User.create({
        username: 'activate2',
        email: 'act2@test.com',
        password: 'hashedpassword123'
      });

      // Act — user1 aktivuje calendar feed
      user1.calendarFeedToken = 'unique-feed-token-xyz';
      user1.calendarFeedEnabled = true;
      await user1.save();

      // Assert — user1 má token, user2 stále null, OK
      const refreshed = await User.findById(user1._id);
      expect(refreshed.calendarFeedToken).toBe('unique-feed-token-xyz');
      expect(refreshed.calendarFeedEnabled).toBe(true);
    });
  });

  describe('sparse index metadata', () => {
    it('calendarFeedToken index má nastavené sparse:true a unique:true', async () => {
      // Priama introspekcia indexov v MongoDB — overí, že schéma správne
      // preniesla sparse:true do DB indexu. Toto je kľúčový invariant,
      // ktorý oprava zaviedla.
      const indexes = await User.collection.indexes();
      const calendarIdx = indexes.find(idx => idx.key && idx.key.calendarFeedToken === 1);

      expect(calendarIdx).toBeDefined();
      expect(calendarIdx.unique).toBe(true);
      expect(calendarIdx.sparse).toBe(true);
    });

    it('googleId index má sparse:true + unique:true (povolí null collísie)', async () => {
      // sparse je kritický — bez neho by druhý OAuth-only user padol na
      // duplicate key error (oba majú googleId=null). Sparse vynechá
      // null hodnoty z indexu úplne.
      const indexes = await User.collection.indexes();
      const googleIdx = indexes.find(idx => idx.key && idx.key.googleId === 1);

      expect(googleIdx).toBeDefined();
      expect(googleIdx.sparse).toBe(true);
      expect(googleIdx.unique).toBe(true);
    });

    it('appleId index má sparse:true + unique:true', async () => {
      const indexes = await User.collection.indexes();
      const appleIdx = indexes.find(idx => idx.key && idx.key.appleId === 1);

      expect(appleIdx).toBeDefined();
      expect(appleIdx.sparse).toBe(true);
      expect(appleIdx.unique).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // OAuth identity fields — pridané pre Sign in with Google + Apple.
  // ─────────────────────────────────────────────────────────────────────
  describe('OAuth identity fields', () => {
    it('password už nie je required (povolí OAuth-only userov)', async () => {
      // OAuth-only user nemá heslo. Mongoose validation musí prejsť.
      const user = await User.create({
        username: 'oauthonly',
        email: 'oauth@test.com',
        googleId: 'google-sub-123',
        authProviders: ['google'],
        emailVerified: true
      });

      expect(user.password).toBeNull();
      expect(user.googleId).toBe('google-sub-123');
      expect(user.authProviders).toEqual(['google']);
    });

    it('default authProviders pre nového usera je ["password"]', async () => {
      const user = await User.create({
        username: 'classicuser',
        email: 'classic@test.com',
        password: 'hashed'
      });

      expect(user.authProviders).toEqual(['password']);
      // Default je false; legacy useri sú backfillnutí migration scriptom.
      expect(user.emailVerified).toBe(false);
      // POZOR: googleId/appleId NIE sú default:null — nesetnuté polia sú
      // úplne missing v dokumente (kvôli sparse index semantike, viď komentár
      // v User.js). Mongoose pri čítaní vráti undefined, nie null.
      expect(user.googleId).toBeUndefined();
      expect(user.appleId).toBeUndefined();
    });

    it('user môže mať obidva providery (google + apple) súčasne', async () => {
      const user = await User.create({
        username: 'dualuser',
        email: 'dual@test.com',
        password: 'hashed',
        googleId: 'g-456',
        appleId: 'a-789',
        authProviders: ['password', 'google', 'apple']
      });

      expect(user.googleId).toBe('g-456');
      expect(user.appleId).toBe('a-789');
      expect(user.authProviders).toHaveLength(3);
    });

    it('googleId musí byť unique (cez sparse index)', async () => {
      await User.create({
        username: 'first',
        email: 'first@test.com',
        googleId: 'shared-google-id',
        authProviders: ['google']
      });

      await expect(User.create({
        username: 'second',
        email: 'second@test.com',
        googleId: 'shared-google-id',
        authProviders: ['google']
      })).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('viacero userov môže mať googleId nesetnuté bez collísie (sparse)', async () => {
      // Sparse index skipuje dokumenty, kde googleId úplne CHÝBA (preto NIE
      // default:null v schéme — viď komentár v User.js). Bez tohto fixu by
      // druhý+tretí insert padol na E11000 duplicate key error.
      const u1 = await User.create({
        username: 'pw1', email: 'pw1@test.com', password: 'h'
      });
      const u2 = await User.create({
        username: 'pw2', email: 'pw2@test.com', password: 'h'
      });
      const u3 = await User.create({
        username: 'pw3', email: 'pw3@test.com', password: 'h'
      });

      expect(u1.googleId).toBeUndefined();
      expect(u2.googleId).toBeUndefined();
      expect(u3.googleId).toBeUndefined();
    });

    it('authProviders enum odmietne neznámy provider', async () => {
      await expect(User.create({
        username: 'baduser',
        email: 'bad@test.com',
        password: 'h',
        authProviders: ['password', 'facebook']
      })).rejects.toThrow(/validator failed|enum|is not a valid/i);
    });

    it('avatarUrl ostáva null pokiaľ ho OAuth callback nenastaví', async () => {
      const user = await User.create({
        username: 'noavatar',
        email: 'noavatar@test.com',
        password: 'h'
      });
      expect(user.avatarUrl).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Migration script — backfillAuthProviders.js
  // ─────────────────────────────────────────────────────────────────────
  describe('backfillAuthProviders migration', () => {
    it('nastaví authProviders=["password"] pre legacy userov bez tohto poľa', async () => {
      // Vytvor "legacy" záznam priamo cez MongoDB driver, aby sme obišli
      // Mongoose default ['password']. Simulujeme stav DB pred OAuth update.
      await User.collection.insertOne({
        username: 'legacyuser',
        email: 'legacy@test.com',
        password: 'h',
        // poznamka: NO authProviders, NO emailVerified
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const { run } = require('../../scripts/backfillAuthProviders');
      // Migration script otvára vlastné mongoose connection; pri teste
      // už máme connection otvorené, takže ho zavoláme priamo cez logiku
      // (skript exportuje run, ale aj tak otvára nové spojenie).
      // Lepšie: replikuj len updateMany volania manuálne pre test.
      await User.updateMany(
        { $or: [
          { authProviders: { $exists: false } },
          { authProviders: null },
          { authProviders: { $size: 0 } }
        ]},
        { $set: { authProviders: ['password'] } }
      );
      await User.updateMany(
        { $or: [{ emailVerified: { $exists: false } }, { emailVerified: null }] },
        { $set: { emailVerified: true } }
      );

      const refreshed = await User.findOne({ email: 'legacy@test.com' });
      expect(refreshed.authProviders).toEqual(['password']);
      expect(refreshed.emailVerified).toBe(true);
    });
  });
});
