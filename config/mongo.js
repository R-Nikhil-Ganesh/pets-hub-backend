const mongoose = require('mongoose');

async function initMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pawprint');
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
}

module.exports = { initMongo };
