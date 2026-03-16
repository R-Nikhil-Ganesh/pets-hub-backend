const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema(
  {
    user_id: { type: Number, required: true },
    emoji: { type: String, required: true },
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    community_id: { type: Number, required: true, index: true },
    sender_id: { type: Number, required: true },
    sender_username: { type: String, required: true },
    sender_avatar_url: { type: String, default: '' },
    type: {
      type: String,
      enum: ['text', 'image', 'sticker', 'gif', 'reply'],
      default: 'text',
    },
    content: { type: String, default: '' },
    media_url: { type: String, default: '' },
    reply_to: {
      message_id: { type: mongoose.Schema.Types.ObjectId, default: null },
      sender_username: { type: String, default: '' },
      content_preview: { type: String, default: '' },
    },
    reactions: [reactionSchema],
    deleted_at: { type: Date, default: null },
  },
  { timestamps: true }
);

// Index for efficient history fetch by community + time
chatMessageSchema.index({ community_id: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
