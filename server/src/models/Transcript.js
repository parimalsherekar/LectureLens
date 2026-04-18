const mongoose = require('mongoose');

const transcriptSchema = new mongoose.Schema({
  roomId:       { type: String, required: true, unique: true },
  fullText:     { type: String, default: '' },
  segments:     { type: Array, default: [] },
  meetingStart: { type: Number },   // epoch ms
  meetingEnd:   { type: Number, default: null },
  status:       { type: String, enum: ['live', 'complete'], default: 'live' },
}, { timestamps: true });

module.exports = mongoose.model('Transcript', transcriptSchema);
