// 通过 GitHub Git Data API 推送本地提交(适用于 git push 被网络阻断时)
// 用法: node scripts/push-via-api.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'uaison/wechat-server';
const BRANCH = 'main';
const LOCAL_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const REMOTE_HEAD = '16d4f3e286da7c8e1f6a7365ef08444a3d702cf6'; // 已知远程 HEAD

const FILES = ['scripts/push-via-api.js'];
const GH = 'C:/Program Files/GitHub CLI/gh.exe';

function gh(args, input) {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[k];
  return execFileSync(GH, args, {
    encoding: 'utf8',
    env,
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function api(method, endpoint, body) {
  const args = ['api', '-X', method, endpoint, '--input', '-'];
  const out = gh(args, JSON.stringify(body));
  return JSON.parse(out);
}

const commitMsg = execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf8' }).trim();

// 1. 取远程 commit 的 tree
console.log('1) 读取远程 HEAD tree...');
const remoteCommit = api('GET', `repos/${REPO}/git/commits/${REMOTE_HEAD}`);
console.log('   tree:', remoteCommit.tree.sha);

// 2. 上传 blob
console.log('2) 上传 blob...');
const blobs = {};
for (const f of FILES) {
  const content = fs.readFileSync(f, 'utf8');
  const res = api('POST', `repos/${REPO}/git/blobs`, { content, encoding: 'utf8' });
  blobs[f] = res.sha;
  console.log(`   ${f} → ${res.sha}`);
}

// 3. 建新 tree(基于远程 tree,覆盖这 3 个文件)
console.log('3) 创建 tree...');
const tree = api('POST', `repos/${REPO}/git/trees`, {
  base_tree: remoteCommit.tree.sha,
  tree: FILES.map((f) => ({ path: f, mode: '100644', type: 'blob', sha: blobs[f] })),
});
console.log('   tree:', tree.sha);

// 4. 建 commit
console.log('4) 创建 commit...');
const commit = api('POST', `repos/${REPO}/git/commits`, {
  message: commitMsg,
  tree: tree.sha,
  parents: [REMOTE_HEAD],
});
console.log('   commit:', commit.sha);

// 5. 更新分支
console.log('5) 更新 ref...');
const ref = api('PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log('   ref →', ref.object.sha);

console.log('\n完成。远程 HEAD 现在:', ref.object.sha);
console.log('本地 HEAD:', LOCAL_HEAD);
if (ref.object.sha !== LOCAL_HEAD) {
  console.log('⚠️ sha 不同(API 重建的 commit 时间戳可能与本地不同,内容一致即可)');
}
