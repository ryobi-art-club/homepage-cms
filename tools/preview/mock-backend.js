/* Preview-only backend. build.cjs injects this with window.PREVIEW_DATA before UiScript;
   serverCall() uses window.MOCK_BACKEND when it exists. Everything happens in memory in this tab
   and nothing reaches Google. Messages and return values follow the real server functions. */
(function () {
  const data = window.PREVIEW_DATA;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const media = (folderId) => clone(data.folders[folderId] || []);
  const folderResponse = (folderId) => ({ folderId, folderName: folderId, folderUrl: '#', files: media(folderId) });
  let counter = 0;
  const nextId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + (++counter);

  window.MOCK_BACKEND = {
    requestOtp: (email) => {
      if (!email) throw new Error('メールアドレスを入力してください。');
      return { ok: true, email: email.replace(/^(.{2}).*@/, '$1***@'), expiresInMinutes: 10 };
    },
    verifyOtp: (email, code) => {
      if (!code) throw new Error('確認コードを入力してください。');
      return { ok: true, sessionToken: 'preview', email, name: data.bootstrap.viewerName, expiresInMinutes: 360 };
    },
    getBootstrapData: () => clone(data.bootstrap),
    getFolderMedia: (_, folderId) => media(folderId),
    getFolderImages: (_, folderId) => media(folderId).filter((file) => file.kind === 'image'),
    loadDraft: (_, draftId) => {
      const draft = (data.bootstrap.drafts || []).find((item) => item.draftId === draftId);
      if (!draft) throw new Error('指定した下書きが見つかりません。');
      return clone(draft.payload);
    },
    previewSiteHistory: () => ({ compared: data.siteHistory || [] }),
    /* 管理者への自動通知の結果。URL の ?notify=sent などか、コンソールで MOCK_BACKEND.notifyMode = 'sent' で切り替える */
    notifyMode: new URLSearchParams(location.search).get('notify') || 'not_configured',
    reportError: () => {
      const mode = window.MOCK_BACKEND.notifyMode;
      if (mode === 'sent') return { notified: true };
      if (mode === 'duplicate') return { notified: true, duplicate: true };
      if (mode === 'failed') throw new Error('プレビュー: 通知に失敗した場合の表示です。');
      return { notified: false, reason: mode };
    },
    saveDraft: (_, payload) => {
      data.bootstrap.drafts.unshift({ draftId: nextId('d'), savedAt: new Date().toISOString(), savedByName: data.bootstrap.viewerName, savedByEmail: data.bootstrap.viewerEmail, payload: clone(payload) });
      return { ok: true, message: '下書きを保存しました。' };
    },
    publishState: (_, payload) => {
      const summary = '[プレビュー] 公開内容を更新';
      data.bootstrap.state = Object.assign({}, data.bootstrap.state, clone(payload));
      data.bootstrap.state.changeLog = [{ timestamp: new Date().toISOString(), summary, actorName: data.bootstrap.viewerName, revision: '' }].concat(data.bootstrap.state.changeLog || []);
      data.bootstrap.drafts = [];
      return { ok: true, message: '公開を開始しました。', changeSummary: summary, actionsUrl: '#' };
    },
    uploadManagedFiles: (_, request) => {
      if (!request.files || !request.files.length) throw new Error('アップロードするファイルを選択してください。');
      const folderId = request.folderId || nextId('f-new');
      const uploadedFileIds = request.files.map((file) => {
        const id = nextId('upload');
        const kind = /^image\//.test(file.mimeType) ? 'image' : 'file';
        const src = 'data:' + file.mimeType + ';base64,' + file.data;
        data.folders[folderId] = (data.folders[folderId] || []).concat({ id, name: file.name, mimeType: file.mimeType, kind, size: file.data.length, url: '#', thumbnailUrl: kind === 'image' ? src : '' });
        return id;
      });
      return Object.assign(folderResponse(folderId), { uploadedFileIds });
    },
    trashManagedFile: (_, request) => {
      const folderId = request.folderId || '';
      /* 展示会の画像は公開まで残し、一覧から外すだけ（本物と同じ） */
      if (/^f-ex-/.test(folderId)) {
        const result = folderResponse(folderId);
        result.files = result.files.filter((file) => file.id !== request.fileId);
        result.deferred = true;
        return result;
      }
      if (!folderId) return { folderId: '', folderUrl: '', files: [], folderTrashed: false };
      data.folders[folderId] = (data.folders[folderId] || []).filter((file) => file.id !== request.fileId);
      if (!data.folders[folderId].length) {
        delete data.folders[folderId];
        return { folderId: '', folderUrl: '', files: [], folderTrashed: true };
      }
      return folderResponse(folderId);
    },
    extractExhibitionCatalog: (_, request) => {
      window.MOCK_BACKEND.lastCatalogRequest = request;
      return clone(data.catalog);
    },
    /* 公開中の文章から最大3項目に、長めの指摘を付ける */
    proofreadForPublish: (_, fields) => {
      const flagged = fields.slice(0, 3);
      return {
        issues: flagged.map((field) => ({
          fieldId: field.id,
          original: field.text.slice(0, 8),
          suggestion: field.text.slice(0, 8) + '（修正案）',
          reason: 'プレビュー用の指摘です。送り仮名や表記ゆれの可能性があります。前後の文脈と合わせて確認してください。'
        })),
        cleanFieldIds: fields.slice(3).map((field) => field.id),
        remainingCount: 0
      };
    },
    markProofreadChecked: () => ({ ok: true })
  };
  document.title = '[プレビュー] ' + document.title;
  /* #login を付けて開くとログイン画面から始める（確認コードは何を入れても通る） */
  if (location.hash === '#login') return;
  document.addEventListener('DOMContentLoaded', () => {
    appState.sessionToken = 'preview';
    document.getElementById('authShell').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    loadBootstrap();
  });
})();
