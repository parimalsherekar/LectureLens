const mongoose = require('mongoose');

// _id is the 8-char roomId string (e.g. "A3F9B2C1")
const meetingSchema = new mongoose.Schema({
  _id:          { type: String },
  hostId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status:       { type: String, enum: ['active', 'ended'], default: 'active' },
  endedAt:      { type: Date, default: null },
}, { timestamps: true });

// Index on participants for fast access-control lookups
meetingSchema.index({ participants: 1 });

module.exports = mongoose.model('Meeting', meetingSchema);
