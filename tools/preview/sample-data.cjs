// Sample content for the preview. It deliberately includes the cases that tend to break layouts:
// long titles and text, a long URL, many images and works, a panorama, missing work titles,
// unpublished items and empty optional fields.

const svg = (w, h, hue, label) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue},35%,45%)"/>` +
  `<text x="50%" y="50%" fill="#fff" font-size="${Math.round(Math.min(w, h) / 8)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${label}</text></svg>`);

const file = (id, w, h, hue) => ({ id, name: id + '.jpg', mimeType: 'image/jpeg', kind: 'image', size: 820000 + w * 50, url: '#', thumbnailUrl: svg(w, h, hue, id) });

/* 24 works with mixed aspect ratios, one panorama */
const shapes = [[1200, 900], [800, 1100], [900, 900], [1000, 1400], [1400, 1000], [2400, 900]];
const manyWorks = Array.from({ length: 24 }, (_, i) => file('work-' + (i + 1), ...shapes[i % shapes.length], (i * 37) % 360));

const folders = {
  'f-recruit-2026': [file('calendar-1', 1600, 900, 50), file('calendar-2', 1600, 900, 80)],
  'f-recruit-2025': [file('calendar-2025', 1600, 900, 30)],
  'f-act-1': [file('act-1', 1200, 800, 140), file('act-2', 800, 1200, 160), file('act-3', 1200, 900, 180)],
  'f-act-2': [file('act-4', 1000, 1000, 200)],
  'f-act-3': Array.from({ length: 7 }, (_, i) => file('fes-' + (i + 1), 1200, 800, 190 + i * 12)),
  'f-ex-1': [file('dm-front', 1000, 1414, 10), file('dm-back', 1000, 1414, 20)].concat(manyWorks),
  'f-ex-2': [file('dm-spring', 1000, 1414, 300), file('spring-1', 1000, 800, 320)],
  'f-ex-3': [file('dm-summer', 1414, 1000, 120)],
  'f-req-1': [file('req-1', 1200, 800, 100), file('req-2', 1200, 800, 110)]
};
const ids = (folder) => folders[folder].map((f) => f.id);
const now = '2026-10-28T03:00:00.000Z';
const artists = ['山田 花子', '佐藤 太郎', '鈴木 一郎', '高橋 美咲', '田中 健', 'Alexandra Konstantinopoulou'];

const state = {
  recruitCalendars: [
    { year: '2026', mediaFolderId: 'f-recruit-2026', folderId: 'f-recruit-2026', mediaFileIds: ids('f-recruit-2026'), label: '2026年度 新歓イベントカレンダー', published: true, updatedAt: now },
    { year: '2025', mediaFolderId: 'f-recruit-2025', folderId: 'f-recruit-2025', mediaFileIds: ids('f-recruit-2025'), label: '2025年度 新歓イベントカレンダー', published: false, updatedAt: now }
  ],
  activityArticles: [
    { articleId: 'a1', title: '秋の合同スケッチ会を開催しました', category: 'record', body: '10月の週末に、キャンパス内でスケッチ会を行いました。\n新入部員も含めて20名が参加し、[作品の一部](https://example.com)を部室に展示しています。', mediaFolderId: 'f-act-1', mediaFileIds: ids('f-act-1'), published: true, createdAt: '2026-10-20T03:00:00.000Z', updatedAt: now },
    { articleId: 'a2', title: '学園祭での似顔絵企画のお知らせ', category: 'event', body: '学園祭2日目に似顔絵ブースを出します。', mediaFolderId: 'f-act-2', mediaFileIds: ids('f-act-2'), published: false, createdAt: '2026-10-25T03:00:00.000Z', updatedAt: now },
    { articleId: 'a3', title: '第48回学園祭 美術部企画「みんなで描く巨大壁画プロジェクト」の制作過程と完成報告、ならびにご協力いただいた皆さまへのお礼', category: 'record', body: '学園祭の3日間で、来場者の皆さまと一緒に縦3メートル・横8メートルの壁画を完成させました。\n\n初日は下描き、2日目は着彩、最終日は仕上げと記念撮影を行いました。延べ300名以上の方に筆を取っていただきました。\n\n制作の様子は [学園祭実行委員会の記録ページ](https://example.com/festival/2026/reports/art-club/mural-project?utm_source=homepage&utm_medium=cms) でも紹介されています。', mediaFolderId: 'f-act-3', mediaFileIds: ids('f-act-3'), published: true, createdAt: '2026-10-05T03:00:00.000Z', updatedAt: now }
  ],
  exhibitions: [
    { exhibitionId: 'e1', title: '凌美会 秋季展覧会 ―境界のむこう側：油彩・水彩・版画・立体による48人の試み―', subtitle: '第48回 凌美会展 / 学外ギャラリー特別展示', theme: '「境界」をテーマに、油彩・水彩・版画など約40点を展示します。\n今年は初めて立体作品のコーナーを設け、来場者が作品に触れられる展示も行います。', venueName: '市民ギャラリー 第2展示室（3階・エレベーター降りて右手）', venueAddress: '東京都千代田区丸の内1-2-3 市民文化センター3階', dateLine: '2026年11月14日(土)〜11月18日(水)', timeLine: '10:00〜18:00（最終日は16:00まで、入場は閉場30分前まで）', mapEmbedUrl: '', displayBucket: 'upcoming', mediaFolderId: 'f-ex-1', driveFolderId: 'f-ex-1', dmFileIds: ['dm-front', 'dm-back'], published: true, startDate: '2026-11-14', endDate: '2026-11-18',
      workFiles: manyWorks.map((work, i) => ({ fileId: work.id, sortOrder: i + 1, title: i % 7 === 6 ? '' : (i === 2 ? '無題（連作「港の記憶」より、第三の習作）' : '作品' + (i + 1)), artist: i % 7 === 6 ? '' : artists[i % artists.length] })) },
    { exhibitionId: 'e2', title: '春季展覧会', subtitle: '', theme: '新入部員の初出展を含む春の展覧会。', venueName: '学生会館ギャラリー', venueAddress: '', dateLine: '2026年5月10日(日)', timeLine: '', mapEmbedUrl: '', displayBucket: 'archive', mediaFolderId: 'f-ex-2', driveFolderId: 'f-ex-2', dmFileIds: ['dm-spring'], published: true, startDate: '2026-05-10',
      workFiles: [{ fileId: 'spring-1', sortOrder: 1, title: '春', artist: '高橋 美咲' }] },
    /* 日付をはっきり書けない会期は手入力（e1・e2 は日付から自動で作る表示と同じ） */
    { exhibitionId: 'e3', title: '夏の小品展', subtitle: '', theme: '', venueName: '', venueAddress: '', dateLine: '2025年8月', timeLine: '', mapEmbedUrl: '', displayBucket: 'archive', mediaFolderId: 'f-ex-3', driveFolderId: 'f-ex-3', dmFileIds: ['dm-summer'], published: false, startDate: '2025-08-01', workFiles: [] }
  ],
  requestCases: [
    { caseId: 'r1', title: '商店街ポスターの制作', body: '地域の商店街から依頼を受け、秋祭りのポスターを制作しました。', mediaFolderId: 'f-req-1', mediaFileIds: ids('f-req-1'), sortOrder: 1, published: true, updatedAt: now },
    { caseId: 'r2', title: '小学校の卒業記念品デザイン（画像なし・非公開）', body: '近隣の小学校から依頼を受け、卒業記念のしおりをデザインしました。児童の皆さんの絵をもとに、部員3名でデザインを担当しています。', mediaFolderId: '', mediaFileIds: [], sortOrder: 2, published: false, updatedAt: now }
  ],
  changeLog: [
    { timestamp: '2026-10-20T03:00:00.000Z', summary: '活動記録「秋の合同スケッチ会を開催しました」を公開', actorName: '部員A', revision: '12' },
    { timestamp: '2026-10-05T03:00:00.000Z', summary: '活動記録「第48回学園祭 美術部企画「みんなで描く巨大壁画プロジェクト」の制作過程と完成報告、ならびにご協力いただいた皆さまへのお礼」を公開', actorName: '部員C', revision: '11' },
    { timestamp: '2026-10-01T03:00:00.000Z', summary: '展示会「凌美会 秋季展覧会」の情報を公開', actorName: '部員B', revision: '10' }
  ],
  manualChangeNote: ''
};
state.recruitCalendar = state.recruitCalendars[0];

module.exports = {
  bootstrap: {
    viewerEmail: 'member@example.com',
    viewerName: '部員A',
    previewUrl: '#',
    state,
    drafts: [
      { draftId: 'd1', savedAt: '2026-10-27T09:12:00.000Z', savedByName: '部員B', savedByEmail: 'b@example.com', payload: JSON.parse(JSON.stringify(state)) },
      { draftId: 'd2', savedAt: '2026-10-26T21:40:00.000Z', savedByName: 'とても長い名前の部員（2年・副部長・広報担当）', savedByEmail: 'long-name-member@example.com', payload: JSON.parse(JSON.stringify(state)) }
    ],
    adminLog: [
      { timestamp: '2026-10-20T03:00:00.000Z', actorName: '部員A', actorEmail: 'member@example.com', action: 'published', detail: '活動記録を1件追加' },
      { timestamp: '2026-10-05T03:00:00.000Z', actorName: '部員C', actorEmail: 'c@example.com', action: 'published', detail: '活動記録を1件追加、展示会の作品情報を24件更新、取り組み事例を1件非公開に変更' }
    ],
    maintenance: { storage: { available: true, level: 'notice', used: 12.4e9, limit: 15e9, remaining: 2.6e9, usageRatio: 0.83, message: 'Drive の空き容量が少なくなっています。' }, recommendations: [] }
  },
  folders,
  /* Drive folders anyone with the link can view: only the published exhibitions, as right after this
     version is deployed (other kinds become viewable at the next publish) */
  publicFolders: ['f-ex-1', 'f-ex-2'],
  /* result of reading an exhibition catalog (returned whatever file is chosen) */
  catalog: {
    sourceName: '秋季展覧会_出品目録.xlsx',
    model: 'preview',
    warnings: ['12番の作者名がかすれていて読み取れませんでした。', '作品数が画像の枚数（24枚）より少なくなっています。'],
    items: Array.from({ length: 12 }, (_, i) => ({
      sortOrder: i + 1,
      artist: i === 11 ? '' : artists[i % artists.length],
      title: i === 2 ? '無題（連作「港の記憶」より、第三の習作）― 夜明け前の埠頭と、消えかけた灯台の光' : '出品作品' + (i + 1),
      size: i % 3 === 0 ? 'F100（1620×1303mm）' : 'F10',
      materials: i % 2 ? '油彩、キャンバス' : '水彩、アクリル、コラージュ、木製パネル'
    }))
  },
  siteHistory: [
    { date: '2026.10.28', items: [{ status: 'added', summary: '展示会「凌美会 秋季展覧会 ―境界のむこう側―」の情報を公開' }, { status: 'removed', summary: '取り組み「小学校の卒業記念品デザイン」' }] },
    { date: '2026.10.20', items: [{ status: 'unchanged', summary: '活動記録「秋の合同スケッチ会を開催しました」を公開' }] }
  ]
};
