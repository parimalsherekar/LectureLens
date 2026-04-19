const mongoose = require('mongoose');

function applyMeetingStatusFields(target) {
  if (!target || typeof target !== 'object' || !('status' in target)) {
    return;
  }

  if (target.status === 'ended' && !('endedAt' in target)) {
    target.endedAt = new Date();
    return;
  }

  if ((target.status === 'live' || target.status === 'active') && !('endedAt' in target)) {
    target.endedAt = null;
  }
}

function normalizeMeetingUpdate(update) {
  if (!update || typeof update !== 'object') {
    return update;
  }

  if (update.$set) {
    applyMeetingStatusFields(update.$set);
  } else {
    applyMeetingStatusFields(update);
  }

  return update;
}

// _id is the 8-char roomId string (e.g. "A3F9B2C1")
const meetingSchema = new mongoose.Schema({
  _id:          { type: String },
  hostId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status:       { type: String, enum: ['active', 'live', 'ended'], default: 'live' },
  endedAt:      { type: Date, default: null },
}, { timestamps: true });

meetingSchema.pre('save', function setEndedAtFromStatus(next) {
  applyMeetingStatusFields(this);
  next();
});

meetingSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function setEndedAtOnUpdate(next) {
  normalizeMeetingUpdate(this.getUpdate());
  next();
});

// Index on participants for fast access-control lookups
meetingSchema.index({ participants: 1 });

module.exports = mongoose.model('Meeting', meetingSchema);
