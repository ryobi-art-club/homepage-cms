// サイトの更新履歴と操作ログの文言

// サイトの更新履歴（ChangeLog、版2）は1行に1つの変更を持つ：kind（種類）・itemId（項目の ID）・note（メモの文）。
// サイトに出す文言は、表示するときに今の内容から作る（タイトルは保存しない。名前を変えても過去の行がそのまま新しい名前になる）。
// 文言の作り方は、サイトのビルド（homepage の sitebuild/sections.py の CHANGE_LOG_TEXT）と同じにする（README「8-4」）
const CHANGE_LOG_ITEM_LISTS = {
  activity: { listName: 'activityArticles', idKey: 'articleId', text: (title) => '活動記録・告知「' + title + '」' },
  request: { listName: 'requestCases', idKey: 'caseId', text: (title) => '取り組み「' + title + '」' },
  exhibition: { listName: 'exhibitions', idKey: 'exhibitionId', text: (title) => '展示会「' + title + '」の情報を公開' }
};

const CHANGE_LOG_RECRUIT_TEXT = '新歓イベントカレンダーを更新';

// 今回の公開で更新履歴に足す行（日時と公開した人は、書くときに付ける）。
// 初めて公開した項目と、新歓カレンダーの差し替え、更新履歴メモ（1行ずつ）。
// 公開に戻した項目は、前に公開したときの行がまた表示されるので足さない。内容を直しただけでも足さない。
// 「初めて」かどうかは、更新履歴（log）にその項目の行がすでにあるかで決める（非公開のまま保存してから初めて公開した項目も、初めてになる）
function buildChangeLogRows_(beforeSnapshot, afterSnapshot, manualNote, log) {
  const rows = [];
  if (recruitCalendarChanged_(beforeSnapshot, afterSnapshot)) rows.push({ kind: 'recruit', itemId: '', note: '' });
  const logged = {};
  (log || []).forEach((row) => logged[row.kind + ':' + row.itemId] = true);
  Object.keys(CHANGE_LOG_ITEM_LISTS).forEach((kind) => {
    const list = CHANGE_LOG_ITEM_LISTS[kind];
    const before = {};
    (beforeSnapshot[list.listName] || []).forEach((item) => before[item[list.idKey]] = item);
    (afterSnapshot[list.listName] || []).forEach((item) => {
      const previous = before[item[list.idKey]];
      const newlyShown = (!previous || previous.published === false) && item.published !== false;
      if (newlyShown && !logged[kind + ':' + item[list.idKey]]) rows.push({ kind, itemId: item[list.idKey], note: '' });
    });
  });
  String(manualNote || '').split('\n').map((line) => line.trim()).filter(Boolean)
    .forEach((note) => rows.push({ kind: 'note', itemId: '', note }));
  return rows;
}

// 公開中の項目の ID → タイトル。titleSnapshot を渡すと、同じ ID の項目があればそちらのタイトルを使う
// （公開前のプレビューで、名前を変えただけの項目を「消えて、足された」と出さないため）
function buildChangeLogTitles_(snapshot, titleSnapshot) {
  const titles = {};
  Object.keys(CHANGE_LOG_ITEM_LISTS).forEach((kind) => {
    const list = CHANGE_LOG_ITEM_LISTS[kind];
    const renamed = {};
    ((titleSnapshot || {})[list.listName] || []).forEach((item) => renamed[item[list.idKey]] = item.title);
    titles[kind] = {};
    ((snapshot || {})[list.listName] || []).filter((item) => item.published !== false).forEach((item) => {
      const title = renamed[item[list.idKey]] || item.title;
      if (title) titles[kind][item[list.idKey]] = title;
    });
  });
  return titles;
}

// サイトに出す文言。非公開・削除した項目の行は空（出さない）
function changeLogText_(row, titles) {
  if (row.kind === 'recruit') return CHANGE_LOG_RECRUIT_TEXT;
  if (row.kind === 'note') return row.note || '';
  const list = CHANGE_LOG_ITEM_LISTS[row.kind];
  const title = list && titles[row.kind][row.itemId];
  return title ? list.text(title) : '';
}

// サイトと同じく、日ごとにまとめ、同じ日の同じ文言は1つにする
function deriveSiteHistoryEntries_(rows, titles) {
  const groups = [];
  const groupIndex = {};
  (rows || []).slice().sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))).forEach((row) => {
    const text = changeLogText_(row, titles);
    if (!text) return;
    const date = formatHistoryDate_(row.timestamp);
    if (!groupIndex[date]) {
      groupIndex[date] = { date, items: [] };
      groups.push(groupIndex[date]);
    }
    if (groupIndex[date].items.indexOf(text) === -1) groupIndex[date].items.push(text);
  });
  return groups;
}

function buildSiteHistoryComparison_(currentEntries, nextEntries) {
  const currentMap = {};
  const nextMap = {};
  const grouped = {};
  const dates = [];
  function ensureDate(date) {
    if (!grouped[date]) {
      grouped[date] = [];
      dates.push(date);
    }
    return grouped[date];
  }

  (currentEntries || []).forEach((entry) => {
    (entry.items || []).forEach((summary, index) => {
      currentMap[entry.date + '::' + summary] = { index: index };
    });
  });
  (nextEntries || []).forEach((entry) => {
    (entry.items || []).forEach((summary, index) => {
      const key = entry.date + '::' + summary;
      nextMap[key] = { index: index };
      ensureDate(entry.date).push({ summary: summary, status: currentMap[key] ? 'unchanged' : 'added', order: index });
    });
  });
  (currentEntries || []).forEach((entry) => {
    (entry.items || []).forEach((summary, index) => {
      const key = entry.date + '::' + summary;
      if (!nextMap[key]) ensureDate(entry.date).push({ summary: summary, status: 'removed', order: 1000 + index });
    });
  });
  return dates.sort((a, b) => String(b).localeCompare(String(a))).map((date) => ({
    date: date,
    items: grouped[date].sort((a, b) => a.order - b.order).map((item) => ({ summary: item.summary, status: item.status }))
  })).filter((entry) => entry.items.length);
}

function formatHistoryDate_(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('.');
}

// 公開中の年度のフォルダが変わったら、新歓カレンダーを更新したとみなす
function recruitCalendarChanged_(beforeSnapshot, afterSnapshot) {
  const folderOf = (snapshot) => {
    const calendar = publishedRecruitCalendar_((snapshot || {}).recruitCalendars);
    return calendar ? calendar.mediaFolderId : '';
  };
  return !!folderOf(afterSnapshot) && folderOf(beforeSnapshot) !== folderOf(afterSnapshot);
}

function buildAdminDiffSummary_(beforeSnapshot, afterSnapshot, manualNote) {
  const messages = [];
  function pushIf(value) {
    if (value && messages.indexOf(value) === -1) messages.push(value);
  }
  function compareCollections(beforeItems, afterItems, idKey, label, stripFn, extraComparator) {
    const beforeMap = {};
    (beforeItems || []).forEach((item) => beforeMap[item[idKey]] = item);
    const afterMap = {};
    (afterItems || []).forEach((item) => afterMap[item[idKey]] = item);
    Object.keys(afterMap).forEach((id) => {
      const before = beforeMap[id];
      const after = afterMap[id];
      if (!before && after.published !== false) {
        pushIf(label + '「' + after.title + '」を公開');
        return;
      }
      if (!before) return;
      if (before.published !== false && after.published === false) {
        pushIf(label + '「' + after.title + '」を非公開');
        return;
      }
      if (before.published === false && after.published !== false) {
        pushIf(label + '「' + after.title + '」を公開に戻す');
      }
      if (extraComparator) {
        const extra = extraComparator(before, after);
        if (extra) pushIf(extra);
      }
      if (stableStringify_(stripFn(before)) !== stableStringify_(stripFn(after))) {
        pushIf(label + '「' + after.title + '」を編集');
      }
    });
    Object.keys(beforeMap).forEach((id) => {
      if (!afterMap[id]) pushIf(label + '「' + beforeMap[id].title + '」を削除');
    });
  }
  if (recruitCalendarChanged_(beforeSnapshot, afterSnapshot)) pushIf('新歓イベントカレンダーを更新');
  compareCollections(beforeSnapshot.activityArticles || [], afterSnapshot.activityArticles || [], 'articleId', '活動記録・告知', function(item) {
    return { title: item.title, body: item.body, category: item.category, mediaFolderId: item.mediaFolderId, mediaFileIds: item.mediaFileIds, createdAt: item.createdAt, published: item.published };
  });
  // ご依頼事例は並び順も内容のうち（並べ替えも「編集」として残す）。順番は、前後のどちらにもある事例どうしで数える
  // （ほかの事例を足したり消したりしただけで、番号がずれて「編集」と出ないように）
  const withPosition = (items, others) => {
    const shared = {};
    (others || []).forEach((item) => shared[item.caseId] = true);
    let position = 0;
    return (items || []).map((item) => Object.assign({ position: shared[item.caseId] ? position++ : -1 }, item));
  };
  compareCollections(withPosition(beforeSnapshot.requestCases, afterSnapshot.requestCases), withPosition(afterSnapshot.requestCases, beforeSnapshot.requestCases), 'caseId', '取り組み', function(item) {
    return { title: item.title, body: item.body, mediaFolderId: item.mediaFolderId, mediaFileIds: item.mediaFileIds, position: item.position, published: item.published };
  });
  compareCollections(beforeSnapshot.exhibitions || [], afterSnapshot.exhibitions || [], 'exhibitionId', '展示会', function(item) {
    return { title: item.title, subtitle: item.subtitle, theme: item.theme, venueName: item.venueName, venueAddress: item.venueAddress, dateLine: item.dateLine, timeLine: item.timeLine, mediaFolderId: item.mediaFolderId, dmFileIds: item.dmFileIds, published: item.published, startDate: item.startDate, endDate: item.endDate || '', works: item.works };
  }, function(before, after) {
    if (before.displayBucket !== after.displayBucket) {
      return after.displayBucket === 'archive' ? '展示会「' + after.title + '」をアーカイブに移動' : '展示会「' + after.title + '」を開催予定に変更';
    }
    return '';
  });
  if (manualNote) pushIf('補足: ' + manualNote);
  return messages.length ? messages.join('\n') : '変更なし';
}
