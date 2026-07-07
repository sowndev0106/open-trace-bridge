const request = require('supertest');

process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-password';

// Returns a supertest agent holding a valid admin session cookie.
// Call after resetDbForTest(): sessions live in the DB.
async function loginAgent(app) {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form')
    .send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
    .expect(302);
  return agent;
}

module.exports = { loginAgent };
