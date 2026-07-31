/* 版本信息区块逻辑（独立脚本，不依赖 popup.js / vip.js）
 * 功能：
 *   1. 从 manifest.json 读取当前版本号与发布日期展示
 *   2. 读取本地 version.json 展示更新日志
 *   3. 点「检查更新」：若 version.json 配置了 updateUrl，则比对远程版本；
 *      否则提示需配置 updateUrl；若配置 repository 则展示「查看仓库」链接
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function semverCmp(a, b) {
    var pa = String(a).split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var pb = String(b).split('.').map(function (x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var da = pa[i] || 0, db = pb[i] || 0;
      if (da !== db) return da < db ? -1 : 1;
    }
    return 0;
  }
  function setResult(msg, ok) {
    var el = $('updateResult');
    if (!el) return;
    el.textContent = msg;
    el.className = 'test-result' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  function renderLocal(info) {
    var manifest = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest() : null;
    var ver = (manifest && manifest.version) || (info && info.version) || '未知';
    if ($('curVersion')) $('curVersion').textContent = 'v' + ver;
    if ($('curVersionDate') && info && info.releaseDate) {
      $('curVersionDate').textContent = '（发布于 ' + info.releaseDate + '）';
    }
    if ($('versionLog') && info && info.changelog) {
      $('versionLog').textContent = info.changelog;
    }
    if (info && info.repository && $('repoLink')) {
      var link = $('repoLink');
      link.href = info.repository;
      link.classList.remove('hidden');
    }
  }

  function checkUpdate(localInfo) {
    var btn = $('checkUpdate');
    if (btn) btn.disabled = true;
    var manifest = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest() : null;
    var curVer = (manifest && manifest.version) || (localInfo && localInfo.version);
    var remoteUrl = localInfo && localInfo.updateUrl;

    if (!remoteUrl) {
      setResult('未配置 updateUrl，无法自动检测远程版本。请在 version.json 填入 updateUrl（指向远程 version.json）。', false);
      if (btn) btn.disabled = false;
      return;
    }
    setResult('正在检查更新…', null);
    fetch(remoteUrl, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (remote) {
        var latest = remote && remote.version;
        if (!latest) throw new Error('远程版本信息格式错误');
        var cmp = semverCmp(latest, curVer);
        if (cmp > 0) {
          var tip = '发现新版本 v' + latest + (remote.releaseDate ? '（' + remote.releaseDate + '）' : '') + '！';
          if (remote.repository) tip += ' 请前往仓库/releases 更新。';
          else if (localInfo && localInfo.repository) tip += ' 请前往仓库更新。';
          setResult(tip, false);
        } else if (cmp === 0) {
          setResult('已是最新版本 v' + curVer, true);
        } else {
          setResult('当前版本 v' + curVer + ' 已高于远程 v' + latest, true);
        }
      })
      .catch(function (e) {
        setResult('检查更新失败：' + e.message, false);
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function init() {
    if (!window.__versionLoaded) window.__versionLoaded = true;
    fetch(chrome.runtime.getURL('version.json'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        renderLocal(info || {});
        var btn = $('checkUpdate');
        if (btn) btn.addEventListener('click', function () { checkUpdate(info || {}); });
      })
      .catch(function () {
        renderLocal({});
        var btn = $('checkUpdate');
        if (btn) btn.addEventListener('click', function () { checkUpdate({}); });
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
