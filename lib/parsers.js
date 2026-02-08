// Parse TaskList tool_result text into structured task items.
// TaskList output format: "#1. [status] Subject\n#2. [status] Subject"
function parseTaskListResult(text) {
  if (!text || typeof text !== 'string') return null;
  const tasks = [];
  const lineRegex = /^#(\d+)\.\s+\[(\w+(?:_\w+)?)\]\s+(.+?)(?:\s*$)/gm;
  let match;
  while ((match = lineRegex.exec(text)) !== null) {
    tasks.push({
      id: match[1],
      status: match[2],
      subject: match[3].trim()
    });
  }
  return tasks.length > 0 ? tasks : null;
}

module.exports = { parseTaskListResult };
