const mongoose = require('mongoose');

function applyTranscriptStatusFields(target) {
  if (!target || typeof target !== 'object' || !('status' in target)) {
    return;
  }

  if (target.status === 'completed' && !('meetingEnd' in target)) {
    target.meetingEnd = Date.now();
    return;
  }

  if (target.status === 'live' && !('meetingEnd' in target)) {
    target.meetingEnd = null;
  }
}

function normalizeTranscriptUpdate(update) {
  if (!update || typeof update !== 'object') {
    return update;
  }

  if (update.$set) {
    applyTranscriptStatusFields(update.$set);
  } else {
    applyTranscriptStatusFields(update);
  }

  return update;
}

const transcriptSchema = new mongoose.Schema({
  roomId:       { type: String, required: true, unique: true },
  fullText:     { type: String, default: '' },
  segments:     { type: Array, default: [] },
  meetingStart: { type: Number },   // epoch ms
  meetingEnd:   { type: Number, default: null },
  status:       { type: String, enum: ['live', 'completed'], default: 'live' },
}, { timestamps: true });

transcriptSchema.pre('save', function setMeetingEndFromStatus(next) {
  applyTranscriptStatusFields(this);
  next();
});

transcriptSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function setMeetingEndOnUpdate(next) {
  normalizeTranscriptUpdate(this.getUpdate());
  next();
});

module.exports = mongoose.model('Transcript', transcriptSchema);
