// Raw application-command payloads registered per bot on connect.
// Option type 3 = STRING (Discord API constant).
const STR = 3;

const COMMAND_DEFS = [
  { name: 'ask', description: 'Ask the investigator a question',
    options: [{ type: STR, name: 'question', description: 'Your question', required: true }] },
  { name: 'new', description: 'Start a new conversation and OpenCode session' },
  { name: 'stop', description: 'Cancel the running investigation' },
  { name: 'status', description: 'Show project, session, model, and run state' },
  { name: 'model', description: 'Show or set the model for this conversation',
    options: [
      { type: STR, name: 'name', description: 'provider/model', autocomplete: true },
      { type: STR, name: 'variant', description: 'Reasoning effort (e.g. high, max, minimal)' },
    ] },
  { name: 'agent', description: 'Show or set the agent for this conversation',
    options: [{ type: STR, name: 'name', description: 'Agent name', autocomplete: true }] },
  { name: 'skills', description: 'List skills available in this project workspace' },
  { name: 'commands', description: 'List custom workspace commands' },
  { name: 'cmd', description: 'Run a custom workspace command',
    options: [
      { type: STR, name: 'name', description: 'Command name', required: true },
      { type: STR, name: 'args', description: 'Arguments' },
    ] },
  { name: 'stats', description: 'Token and cost statistics' },
  { name: 'sync', description: 'Re-pull project sources to the latest remote state' },
  { name: 'guide', description: 'How to use this bot' },
  { name: 'projects', description: 'List projects you can access (DM only)' },
  { name: 'project', description: 'Select the project for this DM (DM only)',
    options: [{ type: STR, name: 'slug', description: 'Project slug', required: true, autocomplete: true }] },
];

module.exports = { COMMAND_DEFS };
