const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      // Žiadne JSON úložisko neexistuje — server beží, ale DB-readiness
      // middleware v index.js vracia 503 na všetky /api requesty.
      logger.error('MONGODB_URI not set — API bude vracať 503, kým sa nenastaví');
      return false;
    }

    // Listenery na stav spojenia — Mongoose emituje 'error' na connection
    // len ak existuje listener, inak sú neskoršie chyby drivera úplne tiché
    // a o výpadku sa server dozvie len nepriamo z readiness middleware
    // (log až po 60 s). connectDB sa volá raz (index.js), takže sa listenery
    // neregistrujú viackrát. Len logujú — správanie pripojenia nemenia.
    mongoose.connection.on('disconnected', () => logger.warn('[DB] disconnected'));
    mongoose.connection.on('reconnected', () => logger.info('[DB] reconnected'));
    mongoose.connection.on('error', (err) => logger.error('[DB] connection error', { error: err?.message }));

    await mongoose.connect(mongoUri, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 60000,
      maxIdleTimeMS: 60000,
    });
    logger.info('MongoDB connected successfully');
    return true;
  } catch (error) {
    logger.error('MongoDB connection error', { error: error.message });
    return false;
  }
};

module.exports = { connectDB };
