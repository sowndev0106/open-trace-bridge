const projects = require('../models/project.model');

function handleEvent(req, res) {
  const project = projects.findBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: `Không có project slug "${req.params.slug}"` });
  res.json({ handled: true, project: project.slug, note: 'pipeline chưa nối (Task 8)' });
}

module.exports = { handleEvent };
