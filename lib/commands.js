const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns an object with name, description, etc.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.substring(0, idx).trim();
    const value = line.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

/**
 * Scan a commands directory for .md files and return command entries.
 * Handles nested directories for namespaced commands (e.g., workflows/plan.md → workflows:plan).
 */
async function scanCommandsDir(dir, prefix = '') {
  const commands = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirectories with namespace prefix
        const nested = await scanCommandsDir(fullPath, entry.name);
        commands.push(...nested);
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = await fsp.readFile(fullPath, 'utf8');
          const fm = parseFrontmatter(content);
          if (fm && fm.name) {
            commands.push({
              name: prefix ? `${prefix}:${fm.name.replace(`${prefix}:`, '')}` : fm.name,
              description: fm.description || ''
            });
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* directory doesn't exist */ }
  return commands;
}

/**
 * Discover all available slash commands from:
 * 1. Built-in Claude Code commands
 * 2. User-global commands (~/.claude/commands/)
 * 3. Project-local commands (.claude/commands/)
 * 4. Installed plugin commands
 *
 * @param {Map} activeSessions - Active sessions map for project-local command discovery
 */
async function discoverCommands(activeSessions) {
  const commands = [];
  const seen = new Set();

  function addCommand(cmd) {
    const key = cmd.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    commands.push(cmd);
  }

  // 1. Built-in commands
  const builtins = [
    { name: 'help', description: 'Show help and available commands' },
    { name: 'clear', description: 'Clear conversation history' },
    { name: 'compact', description: 'Compact conversation to save context' },
    { name: 'config', description: 'Open configuration' },
    { name: 'cost', description: 'Show token usage and cost' },
    { name: 'doctor', description: 'Check Claude Code installation health' },
    { name: 'init', description: 'Initialize project with CLAUDE.md' },
    { name: 'login', description: 'Switch accounts or re-authenticate' },
    { name: 'logout', description: 'Sign out of Claude Code' },
    { name: 'memory', description: 'Edit CLAUDE.md memory files' },
    { name: 'model', description: 'Switch AI model' },
    { name: 'permissions', description: 'View and manage tool permissions' },
    { name: 'review', description: 'Review a pull request' },
    { name: 'status', description: 'Show current session status' },
    { name: 'terminal-setup', description: 'Set up terminal integration' },
    { name: 'vim', description: 'Toggle vim keybindings' },
  ];
  for (const cmd of builtins) addCommand(cmd);

  // 2. User-global commands
  const userCommandsDir = path.join(os.homedir(), '.claude', 'commands');
  const userCmds = await scanCommandsDir(userCommandsDir);
  for (const cmd of userCmds) addCommand(cmd);

  // 3. Project-local commands (scan working directories of active sessions)
  const projectDirs = new Set();
  if (activeSessions) {
    activeSessions.forEach((data) => {
      if (data.session?.cwd) projectDirs.add(data.session.cwd);
    });
  }
  for (const dir of projectDirs) {
    const projectCommandsDir = path.join(dir, '.claude', 'commands');
    const projCmds = await scanCommandsDir(projectCommandsDir);
    for (const cmd of projCmds) addCommand(cmd);
  }

  // 4. Installed plugin commands and skills
  const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const pluginsData = JSON.parse(await fsp.readFile(pluginsFile, 'utf8'));
    for (const [key, installs] of Object.entries(pluginsData.plugins || {})) {
      for (const install of installs) {
        if (!install.installPath) continue;
        // Scan commands/ directory
        const pluginCommandsDir = path.join(install.installPath, 'commands');
        const pluginCmds = await scanCommandsDir(pluginCommandsDir);
        for (const cmd of pluginCmds) addCommand(cmd);
        // Scan skills/ directory (skills use SKILL.md in subdirectories)
        const pluginSkillsDir = path.join(install.installPath, 'skills');
        try {
          const skillEntries = await fsp.readdir(pluginSkillsDir, { withFileTypes: true });
          for (const entry of skillEntries) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(pluginSkillsDir, entry.name, 'SKILL.md');
            try {
              const content = await fsp.readFile(skillFile, 'utf8');
              const fm = parseFrontmatter(content);
              if (fm && fm.name) {
                addCommand({
                  name: fm.name,
                  description: fm.description || ''
                });
              }
            } catch { /* no SKILL.md or unreadable */ }
          }
        } catch { /* no skills directory */ }
      }
    }
  } catch { /* no plugins file */ }

  console.log(`[Commands] Discovered ${commands.length} slash commands`);
  return commands;
}

module.exports = {
  parseFrontmatter,
  scanCommandsDir,
  discoverCommands
};
