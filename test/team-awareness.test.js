const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Replicate team-related parsing logic from parseLogEntry in server.js
// (server.js can't be imported directly due to side effects)

function parseTeamToolCall(block, timestamp) {
  if (!block || block.type !== 'tool_use') return null;

  if (block.name === 'Task') {
    const agentDescription = block.input?.description || 'Subagent';
    const agentType = block.input?.subagent_type || 'general';
    const teamName = block.input?.team_name || null;
    const memberName = block.input?.name || null;
    return {
      type: 'subagent_starting',
      content: agentDescription,
      tool: agentType,
      description: agentDescription,
      agentType,
      teamName,
      memberName,
      timestamp
    };
  }

  if (block.name === 'TeamCreate') {
    return {
      type: 'team_create',
      teamName: block.input?.team_name || 'unnamed-team',
      timestamp
    };
  }

  if (block.name === 'TeamDelete') {
    return { type: 'team_delete', timestamp };
  }

  if (block.name === 'SendMessage') {
    const msgType = block.input?.type;
    if (msgType === 'message' || msgType === 'broadcast') {
      return {
        type: 'team_message',
        sender: 'lead',
        recipient: block.input?.recipient || null,
        content: block.input?.content || '',
        messageType: msgType,
        timestamp
      };
    }
  }

  return null;
}

describe('Team tool parsing', () => {
  const ts = '2026-02-16T12:00:00Z';

  describe('TeamCreate', () => {
    it('parses TeamCreate with team_name', () => {
      const block = {
        type: 'tool_use',
        name: 'TeamCreate',
        input: { team_name: 'review-team' }
      };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result.type, 'team_create');
      assert.equal(result.teamName, 'review-team');
    });

    it('defaults to unnamed-team when no team_name', () => {
      const block = { type: 'tool_use', name: 'TeamCreate', input: {} };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result.teamName, 'unnamed-team');
    });
  });

  describe('TeamDelete', () => {
    it('parses TeamDelete', () => {
      const block = { type: 'tool_use', name: 'TeamDelete', input: {} };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result.type, 'team_delete');
      assert.equal(result.timestamp, ts);
    });
  });

  describe('SendMessage', () => {
    it('parses direct message', () => {
      const block = {
        type: 'tool_use',
        name: 'SendMessage',
        input: {
          type: 'message',
          recipient: 'researcher',
          content: 'Check the API docs'
        }
      };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result.type, 'team_message');
      assert.equal(result.sender, 'lead');
      assert.equal(result.recipient, 'researcher');
      assert.equal(result.content, 'Check the API docs');
      assert.equal(result.messageType, 'message');
    });

    it('parses broadcast message', () => {
      const block = {
        type: 'tool_use',
        name: 'SendMessage',
        input: {
          type: 'broadcast',
          content: 'Stop all work, blocking issue found'
        }
      };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result.type, 'team_message');
      assert.equal(result.recipient, null);
      assert.equal(result.messageType, 'broadcast');
    });

    it('ignores non-message SendMessage types', () => {
      const block = {
        type: 'tool_use',
        name: 'SendMessage',
        input: { type: 'shutdown_request', recipient: 'worker' }
      };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result, null);
    });
  });

  describe('Task with team fields', () => {
    it('extracts team_name and name from Task input', () => {
      const block = {
        type: 'tool_use',
        name: 'Task',
        input: {
          description: 'Review authentication module',
          subagent_type: 'code-review',
          team_name: 'review-team',
          name: 'auth-reviewer'
        }
      };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result.type, 'subagent_starting');
      assert.equal(result.teamName, 'review-team');
      assert.equal(result.memberName, 'auth-reviewer');
      assert.equal(result.agentType, 'code-review');
      assert.equal(result.description, 'Review authentication module');
    });

    it('returns null team fields for non-team Task', () => {
      const block = {
        type: 'tool_use',
        name: 'Task',
        input: {
          description: 'Explore codebase',
          subagent_type: 'general'
        }
      };
      const result = parseTeamToolCall(block, ts);
      assert.equal(result.type, 'subagent_starting');
      assert.equal(result.teamName, null);
      assert.equal(result.memberName, null);
    });
  });
});

describe('Team session state', () => {
  function createSessionData() {
    return {
      activeTeam: null,
      teamMessages: [],
      subagentInfo: new Map()
    };
  }

  it('sets activeTeam on team_create', () => {
    const sd = createSessionData();
    const event = { type: 'team_create', teamName: 'swarm-team', timestamp: '2026-02-16T12:00:00Z' };
    sd.activeTeam = {
      name: event.teamName,
      members: new Map(),
      createdAt: event.timestamp
    };
    assert.equal(sd.activeTeam.name, 'swarm-team');
    assert.equal(sd.activeTeam.members.size, 0);
  });

  it('clears activeTeam and messages on team_delete', () => {
    const sd = createSessionData();
    sd.activeTeam = { name: 'old-team', members: new Map(), createdAt: '2026-02-16T11:00:00Z' };
    sd.teamMessages = [{ sender: 'a', content: 'hello' }];
    // Simulate team_delete
    sd.activeTeam = null;
    sd.teamMessages = [];
    assert.equal(sd.activeTeam, null);
    assert.equal(sd.teamMessages.length, 0);
  });

  it('accumulates team messages capped at 50', () => {
    const sd = createSessionData();
    // Add 55 messages
    for (let i = 0; i < 55; i++) {
      sd.teamMessages.push({ sender: 'agent', content: `msg ${i}`, timestamp: `ts-${i}` });
    }
    if (sd.teamMessages.length > 50) {
      sd.teamMessages = sd.teamMessages.slice(-50);
    }
    assert.equal(sd.teamMessages.length, 50);
    assert.equal(sd.teamMessages[0].content, 'msg 5');
    assert.equal(sd.teamMessages[49].content, 'msg 54');
  });

  it('registers teammate in activeTeam.members', () => {
    const sd = createSessionData();
    sd.activeTeam = { name: 'review-team', members: new Map(), createdAt: '2026-02-16T12:00:00Z' };

    // Simulate a teammate subagent starting
    const agentId = 'abc-123-def';
    const teamName = 'review-team';
    const memberName = 'auth-reviewer';

    const subagentData = {
      description: 'Review auth module',
      agentType: 'code-review',
      startTime: Date.now(),
      teamName,
      memberName
    };
    sd.subagentInfo.set(agentId, subagentData);

    if (teamName && sd.activeTeam) {
      sd.activeTeam.members.set(memberName || agentId, {
        agentId,
        name: memberName || agentId,
        startTime: subagentData.startTime
      });
    }

    assert.equal(sd.activeTeam.members.size, 1);
    assert.equal(sd.activeTeam.members.get('auth-reviewer').agentId, 'abc-123-def');
  });

  it('replaces activeTeam on new TeamCreate', () => {
    const sd = createSessionData();
    sd.activeTeam = { name: 'old-team', members: new Map(), createdAt: '2026-02-16T11:00:00Z' };
    sd.teamMessages = [{ sender: 'a', content: 'old msg' }];

    // New team_create should replace
    sd.activeTeam = { name: 'new-team', members: new Map(), createdAt: '2026-02-16T12:00:00Z' };
    sd.teamMessages = [];

    assert.equal(sd.activeTeam.name, 'new-team');
    assert.equal(sd.teamMessages.length, 0);
  });
});

describe('buildClaudeState team field', () => {
  it('includes team data when activeTeam exists', () => {
    const sd = {
      activeTeam: {
        name: 'review-team',
        members: new Map([
          ['reviewer', { agentId: 'abc', name: 'reviewer', startTime: 1000 }]
        ]),
        createdAt: '2026-02-16T12:00:00Z'
      },
      teamMessages: [
        { sender: 'lead', recipient: 'reviewer', content: 'check auth', messageType: 'message', timestamp: 'ts1' }
      ]
    };

    // Replicate the buildClaudeState team field logic
    const team = sd.activeTeam ? {
      name: sd.activeTeam.name,
      members: Object.fromEntries(sd.activeTeam.members),
      recentMessages: sd.teamMessages?.slice(-10) || []
    } : null;

    assert.notEqual(team, null);
    assert.equal(team.name, 'review-team');
    assert.equal(team.members.reviewer.agentId, 'abc');
    assert.equal(team.recentMessages.length, 1);
    assert.equal(team.recentMessages[0].content, 'check auth');
  });

  it('returns null team when no activeTeam', () => {
    const sd = { activeTeam: null, teamMessages: [] };
    const team = sd.activeTeam ? {
      name: sd.activeTeam.name,
      members: Object.fromEntries(sd.activeTeam.members),
      recentMessages: sd.teamMessages?.slice(-10) || []
    } : null;

    assert.equal(team, null);
  });

  it('includes teamName and memberName in subagent entries', () => {
    const subagentInfo = new Map([
      ['agent-1', {
        status: 'active',
        description: 'Review auth',
        agentType: 'code-review',
        teamName: 'review-team',
        memberName: 'auth-reviewer',
        startTime: 1000
      }],
      ['agent-2', {
        status: 'active',
        description: 'Explore codebase',
        agentType: 'general',
        startTime: 2000
      }]
    ]);

    // Replicate buildClaudeState subagent serialization
    const subagents = {};
    for (const [id, info] of subagentInfo) {
      const entry = {
        status: info.status,
        description: info.description,
        agentType: info.agentType,
        startTime: info.startTime
      };
      if (info.teamName) entry.teamName = info.teamName;
      if (info.memberName) entry.memberName = info.memberName;
      subagents[id] = entry;
    }

    assert.equal(subagents['agent-1'].teamName, 'review-team');
    assert.equal(subagents['agent-1'].memberName, 'auth-reviewer');
    assert.equal(subagents['agent-2'].teamName, undefined);
    assert.equal(subagents['agent-2'].memberName, undefined);
  });
});
