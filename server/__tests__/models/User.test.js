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
  });
});
