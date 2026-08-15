const express = require('express');
const router = express.Router();

router.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = router;
