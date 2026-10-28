/* Preview-only backend. build.cjs injects this with window.PREVIEW_DATA before UiScript;
   serverCall() uses window.MOCK_BACKEND when it exists. Nothing here can write to Google. */
(function () {
  const data = window.PREVIEW_DATA;
  const media = (folderId) => JSON.parse(JSON.stringify(data.folders[folderId] || []));
  const readOnly = () => {
    throw new Error('プレビューでは保存・公開・ファイル操作はできません。');
  };
  window.MOCK_BACKEND = {
    getBootstrapData: () => JSON.parse(JSON.stringify(data.bootstrap)),
    getFolderMedia: (_, folderId) => media(folderId),
    getFolderImages: (_, folderId) => media(folderId).filter((file) => file.kind === 'image'),
    loadDraft: (_, draftId) => {
      const draft = (data.bootstrap.drafts || []).find((item) => item.draftId === draftId);
      if (!draft) throw new Error('指定した下書きが見つかりません。');
      return JSON.parse(JSON.stringify(draft.payload));
    },
    previewSiteHistory: () => ({ compared: data.siteHistory || [] }),
    reportError: () => ({ notified: false, reason: 'not_configured' }),
    saveDraft: readOnly,
    publishState: readOnly,
    uploadManagedFiles: readOnly,
    trashManagedFile: readOnly,
    extractExhibitionCatalog: readOnly,
    proofreadForPublish: () => ({ issues: [] }),
    markProofreadChecked: () => ({ ok: true })
  };
  document.title = '[プレビュー] ' + document.title;
  /* #login を付けて開くとログイン画面を表示する */
  if (location.hash === '#login') return;
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('authShell').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    loadBootstrap();
  });
})();
