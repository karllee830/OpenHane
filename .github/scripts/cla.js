const CLA_URL = 'https://gist.github.com/karllee830/5236f985bd1cb302d51bd506c5e91b80';
const CLA_GIST_ID = CLA_URL.split('/').pop();
const BRANCH = 'cla-signatures';
const FILE = 'signatures.json';
const STATUS_CONTEXT = 'license/cla';
const MARKER = '<!-- openhane-cla -->';
// 项目所有者和以 [bot] 结尾的账号也免签
const ALLOWLIST = ['dependabot[bot]', 'github-actions[bot]'];
// 与 .github/pull_request_template.md 中的勾选框一致
const CHECKBOX = /^\s*[-*]\s*\[[xX]\]\s*I have read the \[OpenHane Contributor Agreement\]/m;
const SIGN_PHRASE = 'I have read the OpenHane Contributor Agreement and agree to its terms.';

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;

  let pr = context.payload.pull_request;
  if (!pr) {
    if (!context.payload.issue?.pull_request) return;
    pr = (await github.rest.pulls.get({ owner, repo, pull_number: context.payload.issue.number })).data;
  }
  if (pr.state !== 'open') return;

  const exempt = (login) => !login || login === owner || login.endsWith('[bot]') || ALLOWLIST.includes(login);

  // 没有关联 GitHub 账号的提交作者无法签署
  const required = new Map([[pr.user.login, pr.user.id]]);
  const unlinked = new Set();
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pr.number, per_page: 100 });
  for (const c of commits) {
    if (c.author?.login) required.set(c.author.login, c.author.id);
    else unlinked.add(c.commit.author?.email || c.commit.author?.name || c.sha.slice(0, 7));
  }
  for (const login of [...required.keys()]) if (exempt(login)) required.delete(login);

  let signatures = [];
  let fileSha;
  try {
    const res = await github.rest.repos.getContent({ owner, repo, path: FILE, ref: BRANCH });
    fileSha = res.data.sha;
    signatures = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const signed = (id) => signatures.some((s) => s.id === id);

  const newSigners = [];
  const event = context.eventName;
  const sender = context.payload.sender;
  if (event === 'pull_request_target' && sender.login === pr.user.login && CHECKBOX.test(pr.body || '') && !signed(pr.user.id)) {
    newSigners.push({ login: pr.user.login, id: pr.user.id, via: 'pull request description' });
  }
  if (event === 'issue_comment' && context.payload.action === 'created') {
    const body = (context.payload.comment.body || '').trim();
    if (body === SIGN_PHRASE && required.has(sender.login) && !signed(sender.id)) {
      newSigners.push({ login: sender.login, id: sender.id, via: context.payload.comment.html_url });
    }
  }

  if (newSigners.length) {
    const gist = (await github.rest.gists.get({ gist_id: CLA_GIST_ID })).data;
    const version = gist.history?.[0]?.version ?? '';
    const now = new Date().toISOString();
    for (const s of newSigners) {
      signatures.push({ login: s.login, id: s.id, pullRequest: pr.number, signedVia: s.via, signedAt: now, agreement: CLA_URL, agreementVersion: version });
    }
    await saveSignatures(github, owner, repo, signatures, fileSha, `Signature: ${newSigners.map((s) => s.login).join(', ')} (#${pr.number})`);
  }

  const unsigned = [...required.entries()].filter(([, id]) => !signed(id)).map(([login]) => login);
  const ok = unsigned.length === 0 && unlinked.size === 0;

  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: pr.head.sha,
    state: ok ? 'success' : 'failure',
    context: STATUS_CONTEXT,
    description: ok ? 'All contributors have agreed to the Contributor Agreement' : 'Waiting for contributors to agree to the Contributor Agreement',
    target_url: CLA_URL,
  });

  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
  const existing = comments.find((c) => c.user.type === 'Bot' && c.body.includes(MARKER));
  const body = ok ? passedComment() : pendingComment(pr.user.login, unsigned, [...unlinked]);
  if (existing) {
    if (existing.body !== body) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else if (!ok) {
    await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
  }
  core.info(ok ? 'All contributors have signed.' : `Unsigned: ${unsigned.join(', ')}; unlinked: ${[...unlinked].join(', ')}`);
};

/** 分支不存在时创建一个没有父提交的独立分支 */
async function saveSignatures(github, owner, repo, signatures, sha, message) {
  const content = Buffer.from(`${JSON.stringify(signatures, null, 2)}\n`).toString('base64');
  try {
    await github.rest.repos.createOrUpdateFileContents({ owner, repo, path: FILE, branch: BRANCH, message, content, sha });
    return;
  } catch (e) {
    if (e.status !== 404 && e.status !== 422) throw e;
  }
  const blob = await github.rest.git.createBlob({ owner, repo, content, encoding: 'base64' });
  const tree = await github.rest.git.createTree({ owner, repo, tree: [{ path: FILE, mode: '100644', type: 'blob', sha: blob.data.sha }] });
  const commit = await github.rest.git.createCommit({ owner, repo, message, tree: tree.data.sha, parents: [] });
  await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${BRANCH}`, sha: commit.data.sha });
}

function pendingComment(author, unsigned, unlinked) {
  const lines = [
    MARKER,
    `Thank you for your contribution! Before we can merge it, every contributor needs to agree to the [OpenHane Contributor Agreement](${CLA_URL}). You only need to agree once.`,
    `感谢你的贡献！合并之前，每位贡献者都需要同意[羽见贡献者协议](${CLA_URL})。只需要同意一次。`,
    '',
  ];
  if (unsigned.includes(author)) {
    lines.push(
      `- @${author}: please tick the Contributor Agreement checkbox in the pull request description. / 请在拉取请求的描述里勾选贡献者协议。`,
    );
  }
  for (const login of unsigned.filter((l) => l !== author)) {
    lines.push(`- @${login}: please reply to this pull request with the following sentence. / 请在这个拉取请求下回复下面这句话：`);
  }
  if (unsigned.some((l) => l !== author)) lines.push('', '```', SIGN_PHRASE, '```');
  if (unlinked.length) {
    lines.push(
      '',
      `Some commits are authored by ${unlinked.map((u) => `\`${u}\``).join(', ')}, which is not linked to a GitHub account. Please add the email to your GitHub account or amend the commits.`,
      `有些提交的作者（${unlinked.map((u) => `\`${u}\``).join('、')}）没有关联 GitHub 账号，请把这个邮箱添加到你的 GitHub 账号，或者修改这些提交的作者信息。`,
    );
  }
  return lines.join('\n');
}

function passedComment() {
  return [MARKER, 'All contributors have agreed to the Contributor Agreement. Thank you!', '所有贡献者都已同意贡献者协议，谢谢！'].join('\n');
}
