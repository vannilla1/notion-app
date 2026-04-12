const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      logger.info('MONGODB_URI not set, using local JSON storage');
      return false;
    }

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
