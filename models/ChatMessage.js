const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema(
  {
    emoji: { type: String, required: true },
    count: { type: Number, default: 1 },
    user_ids: [{ type: Number }], // Track who reacted for user_reacted flag
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    community_id: { type: Number, required: true, index: true },
    sender_id: { type: Number, required: true },
    sender_username: { type: String, required: true },
    sender_display_name: { type: String, default: '' },
    sender_avatar: { type: String, default: '' },
    type: {
      type: String,
      enum: ['text', 'image', 'sticker', 'gif', 'reply'],
      default: 'text',
    },
    content: { type: String, default: '' },
    media_url: { type: String, default: '' },
    // Backward-compatible: legacy docs stored an object payload here.
    reply_to: { type: mongoose.Schema.Types.Mixed, default: null },
    reply_preview: { type: String, default: null },
    reactions: { type: [reactionSchema], default: [] },
    deleted_at: { type: Date, default: null },
  },
  { timestamps: true }
);

chatMessageSchema.pre('validate', function ensureDisplayName(next) {
  if (!this.sender_display_name) {
    this.sender_display_name = this.sender_username || '';
  }
  next();
});

// Index for efficient history fetch by community + time
chatMessageSchema.index({ community_id: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
