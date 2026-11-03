'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// This collector never executes PR code or follows arbitrary external URLs.
async function collectContext(env, request = fetch) {
  const repo = env.GITHUB_REPOSITORY;
  const number = Number(env.PR_NUMBER);
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !Number.isSafeInteger(number) || number < 1)
    throw new Error('Invalid review repository or pull request number.');
  const gaps = [];
  const sources = [];
  async function get(endpoint) {
    const response = await request(`${api}${endpoint}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Context API returned ${response.status} for ${endpoint.split('?')[0]}`);
    sources.push(endpoint);
    return response.json();
  }
  async function pages(endpoint, select = value => value) {
    const rows = [];
    for (let page = 1; page <= 20; page++) {
      const batch = select(await get(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
      if (!Array.isArray(batch)) throw new Error('Invalid paginated context response.');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    gaps.push(`${endpoint}: pagination limit reached; later records are missing.`);
    return rows;
  }
  function text(value, limit, source) {
    const raw = String(value || '');
    if (raw.length <= limit) return raw;
    gaps.push(`${source}: text shortened from ${raw.length} to ${limit} characters.`);
    return raw.slice(0, limit) + '\n[TRUNCATED; see source URL]';
  }
  function recent(rows, limit, source) {
    if (rows.length > limit) gaps.push(`${source}: showing latest ${limit} of ${rows.length} records.`);
    return rows.slice(-limit);
  }
  const prefix = `/repos/${repo}`;
  const pr = await get(`${prefix}/pulls/${number}`);
  if (pr.head.sha !== env.HEAD_SHA) throw new Error('PR head changed before context collection.');
  const conversation = await pages(`${prefix}/issues/${number}/comments`);
  const reviews = await pages(`${prefix}/pulls/${number}/reviews`);
  const inline = await pages(`${prefix}/pulls/${number}/comments`);
  const commits = await pages(`${prefix}/pulls/${number}/commits`);
  const files = await pages(`${prefix}/pulls/${number}/files`);
  const checks = await pages(`${prefix}/commits/${pr.head.sha}/check-runs`, value => value.check_runs);
  const statuses = await pages(`${prefix}/commits/${pr.head.sha}/statuses`);
  function comment(row) {
    return {
      url: row.html_url, author: row.user?.login, created_at: row.created_at,
      updated_at: row.updated_at, state: row.state, path: row.path, line: row.line,
      original_line: row.original_line, commit_id: row.commit_id,
      in_reply_to_id: row.in_reply_to_id,
      body: text(row.body, 2500, row.html_url || 'comment'),
    };
  }
  const linked = new Map();
  const addLink = (repository, id, kind = 'issues') => {
    if (repository === repo && Number(id) === number) return;
    linked.set(`${repository}#${id}`, { repository, number: Number(id), kind });
  };
  // Only structured issue links on GitHub and explicit references in PR metadata.
  const metadata = `${pr.title || ''}\n${pr.body || ''}`;
  for (const match of metadata.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)\b/g))
    addLink(match[1], match[3], match[2] === 'pull' ? 'pulls' : 'issues');
  for (const match of metadata.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) addLink(match[1], match[2]);
  for (const match of metadata.matchAll(/(?:^|[\s(])#(\d+)\b/g)) addLink(repo, match[1]);
  // Closing references also cover issues linked using GitHub's Development UI.
  let cursor = null;
  try {
    for (let page = 1; page <= 20; page++) {
      const [owner, name] = repo.split('/');
      const response = await request(`${api}/graphql`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GH_TOKEN}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          query: 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}',
          variables: { owner, name, number, cursor },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (result.errors?.length) throw new Error('GraphQL access or query failure');
      const connection = result.data?.repository?.pullRequest?.closingIssuesReferences;
      if (!connection) throw new Error('Missing closing-issue connection');
      for (const issue of connection.nodes) addLink(issue.repository.nameWithOwner, issue.number);
      if (!connection.pageInfo.hasNextPage) break;
      if (page === 20) gaps.push('Closing issues: pagination limit reached.');
      cursor = connection.pageInfo.endCursor;
    }
  } catch (error) {
    gaps.push(`GitHub Development closing issues unavailable (${error.message}); explicit references were still collected.`);
  }
  const related = [];
  const links = [...linked.values()];
  if (links.length > 8) gaps.push(`Linked work: only first 8 of ${links.length} references collected.`);
  for (const link of links.slice(0, 8)) {
    const endpoint = `/repos/${link.repository}/${link.kind}/${link.number}`;
    try {
      const issue = await get(endpoint);
      const discussion = await pages(`/repos/${link.repository}/issues/${link.number}/comments`);
      related.push({
        url: issue.html_url, title: issue.title, state: issue.state,
        body: text(issue.body, 16000, issue.html_url),
        comments: recent(discussion, 10, issue.html_url).map(comment),
      });
    } catch (error) { gaps.push(`Linked work ${link.repository}#${link.number} unavailable (${error.message}).`); }
  }
  const context = {
    schema_version: 1, repository: repo, pr_number: number,
    head_sha: pr.head.sha, base_sha: pr.base.sha, base_ref: pr.base.ref,
    pull_request: {
      url: pr.html_url, title: pr.title, body: text(pr.body, 48000, pr.html_url),
      author: pr.user?.login, labels: (pr.labels || []).map(label => label.name),
    },
    conversation: recent(conversation, 30, 'PR conversation').map(comment),
    reviews: recent(reviews, 30, 'PR reviews').map(comment),
    inline_discussions: recent(inline, 60, 'PR inline discussions').map(comment),
    commits: recent(commits, 50, 'PR commits').map(row => ({ sha: row.sha, message: text(row.commit?.message, 2000, row.sha) })),
    changed_files: files.map(row => ({ path: row.filename, previous_path: row.previous_filename, status: row.status, additions: row.additions, deletions: row.deletions })),
    checks: checks.map(row => ({ name: row.name, status: row.status, conclusion: row.conclusion, url: row.details_url })),
    commit_statuses: statuses.map(row => ({ name: row.context, state: row.state, url: row.target_url })),
    linked_work: related,
    external_references: [...new Set((metadata.match(/https:\/\/[^\s<>"\)]+/g) || []).filter(url => !url.startsWith('https://github.com/')))],
    coverage: { sources, gaps, note: 'External documents and private chat history are not fetched. Repository guidance and referenced local contracts must be read separately. Checks are observations, not proof of manual acceptance.' },
  };
  // Never silently drop the tail of a packet: force an explicit incomplete run.
  if (Buffer.byteLength(JSON.stringify(context)) > 512000) throw new Error('Review context exceeds 512 KB; narrow the PR or collect a focused review packet.');
  return context;
}

function serializeContext(context) {
  function wrap(value) {
    if (typeof value === 'string' && JSON.stringify(value).length > 1200) {
      const chunks = [];
      let chunk = '', length = 0;
      for (const char of value) {
        const size = JSON.stringify(char).length - 2;
        if (length + size > 1000) { chunks.push(chunk); chunk = ''; length = 0; }
        chunk += char; length += size;
      }
      if (chunk) chunks.push(chunk);
      return { format: 'text_chunks', chunks };
    }
    if (Array.isArray(value)) return value.map(wrap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wrap(item)]));
    return value;
  }
  const content = JSON.stringify(wrap(context), null, 2) + '\n';
  if (Buffer.byteLength(content) > 512000) throw new Error('Formatted review context exceeds 512 KB.');
  return content;
}

function hasContextRead(messages, file, content) {
  if (typeof content !== 'string' || !content.length) return false;
  const expected = content.replace(/\n$/, '').split('\n');
  const seen = new Set();
  const blocks = row => Array.isArray(row.message?.content) ? row.message.content : [];
  const reads = new Set(messages.flatMap(row => row.type === 'assistant'
    ? blocks(row).filter(block => block.type === 'tool_use' && block.name === 'Read' && block.input?.file_path === file).map(block => block.id)
    : []));
  for (const row of messages.filter(row => row.type === 'user')) {
    for (const block of blocks(row)) {
      if (block.type !== 'tool_result' || !reads.has(block.tool_use_id) || block.is_error) continue;
      const output = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content) ? block.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
      // Read uses cat-n-style line prefixes. Count only complete, matching lines
      // actually returned by the tool; requested offsets/limits are not evidence.
      for (const match of output.matchAll(/^[ \t]*(\d+)[→\t](.*)$/gm)) {
        const line = Number(match[1]);
        if (line >= 1 && line <= expected.length && match[2] === expected[line - 1]) seen.add(line);
      }
    }
  }
  return seen.size === expected.length;
}

async function main() {
  const context = await collectContext(process.env);
  const content = serializeContext(context);
  const file = path.join(process.env.RUNNER_TEMP, 'claude-review-context.json');
  fs.writeFileSync(file, content, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `file=${file}\nsha256=${sha256}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `lines=${content.trimEnd().split('\n').length}\n`);
  // Do not print PR text, personal data, or raw API payloads to Actions logs.
  console.log(`Collected PR review context: ${context.changed_files.length} files, ${context.linked_work.length} linked work items, ${context.coverage.gaps.length} explicit gaps.`);
}

module.exports = { collectContext, serializeContext, hasContextRead };
if (require.main === module) main().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
