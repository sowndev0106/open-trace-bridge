const router = require('express').Router();
const projects = require('../models/project.model');
const { executeApiCall } = require('../services/callapi.service');
const { getInternalToken } = require('../services/workspace.service');

router.post('/call-api', async (req, res) => {
  if (req.get('x-otb-internal-token') !== getInternalToken()) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { slug, group, method, path, params } = req.body || {};
  const project = projects.findBySlug(slug);
  if (!project) return res.status(404).json({ error: `project "${slug}" does not exist` });
  try {
    const result = await executeApiCall({ project, groupName: group, method, path, params });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
