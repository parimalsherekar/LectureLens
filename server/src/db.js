const mongoose = require('mongoose');

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[DB] Connected to MongoDB:', process.env.MONGO_URI);
}

module.exports = { connectDB };
