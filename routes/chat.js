const router = require('express').Router();
const ChatMessage = require('../models/ChatMessage');
const { verifyToken } = require('../middleware/auth');
const { upload, uploadStream } = require('../middleware/upload');

// GET /api/chat/:communityId?before=<ISO>&limit=30
router.get('/:communityId', verifyToken, async (req, res) => {
  const communityId = Number(req.params.communityId);
  const limit = Number(req.query.limit) || 30;
  const before = req.query.before ? new Date(req.query.before) : new Date();

  try {
    const messages = await ChatMessage.find({
      community_id: communityId,
      deleted_at: null,
      createdAt: { $lt: before },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ messages: messages.reverse() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// POST /api/chat/:communityId/image — upload image for chat
router.post('/:communityId/image', verifyToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required' });
  try {
    const url = await uploadStream(req.file.buffer, 'pawprint/chat');
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// DELETE /api/chat/message/:messageId — soft delete own message
router.delete('/message/:messageId', verifyToken, async (req, res) => {
  try {
    const msg = await ChatMessage.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    msg.deleted_at = new Date();
    await msg.save();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
