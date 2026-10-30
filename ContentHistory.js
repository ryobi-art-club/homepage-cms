// サイトの更新履歴と操作ログの文言

function summarizeChange_(beforeSnapshot, afterSnapshot, manualNote) {
  const messages = [];
  if (recruitCalendarChanged_(beforeSnapshot, afterSnapshot)) messages.push('新歓イベントカレンダーを更新');

  const beforeActivities = {};
  (beforeSnapshot.activityArticles || []).forEach((item) => beforeActivities[item.articleId] = item);
  (afterSnapshot.activityArticles || []).forEach((item) => {
    const before = beforeActivities[item.articleId];
    if ((!before || before.published === false) && item.published !== false) messages.push('活動記録・告知「' + item.title + '」');
  });

  const beforeRequests = {};
  (beforeSnapshot.requestCases || []).forEach((item) => beforeRequests[item.caseId] = item);
  (afterSnapshot.requestCases || []).forEach((item) => {
    const before = beforeRequests[item.caseId];
    if ((!before || before.published === false) && item.published !== false) messages.push('取り組み「' + item.title + '」');
  });

  const beforeExhibitions = {};
  (beforeSnapshot.exhibitions || []).forEach((item) => beforeExhibitions[item.exhibitionId] = item);
  (afterSnapshot.exhibitions || []).forEach((item) => {
    const before = beforeExhibitions[item.exhibitionId];
    if ((!before || before.published === false) && item.published !== false) messages.push('展示会「' + item.title + '」の情報を公開');
  });

  if (manualNote) messages.push(manualNote);
  return messages.length ? messages.join('\n') : '';
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
  // ご依頼事例は並び順も内容のうち（並べ替えも「編集」として残す）
  const withPosition = (items) => (items || []).map((item, position) => Object.assign({ position }, item));
  compareCollections(withPosition(beforeSnapshot.requestCases), withPosition(afterSnapshot.requestCases), 'caseId', '取り組み', function(item) {
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

function buildTitleReplacements_(beforeSnapshot, afterSnapshot) {
  const replacements = [];
  collectTitleReplacements_(beforeSnapshot.activityArticles, afterSnapshot.activityArticles, 'activity', 'articleId', ['活動記録・告知', '活動記事'], replacements);
  collectTitleReplacements_(beforeSnapshot.requestCases, afterSnapshot.requestCases, 'request', 'caseId', ['取り組み', '取り組み事例', 'ご依頼事例'], replacements);
  collectTitleReplacements_(beforeSnapshot.exhibitions, afterSnapshot.exhibitions, 'exhibition', 'exhibitionId', ['展示会'], replacements);
  return replacements;
}

function collectTitleReplacements_(beforeItems, afterItems, kind, idKey, labels, out) {
  const beforeMap = {};
  (beforeItems || []).forEach((item) => {
    if (item && item[idKey]) beforeMap[item[idKey]] = item;
  });
  (afterItems || []).forEach((item) => {
    if (!item || !item[idKey]) return;
    const before = beforeMap[item[idKey]];
    if (!before) return;
    const oldTitle = String(before.title || '').trim();
    const newTitle = String(item.title || '').trim();
    if (oldTitle && newTitle && oldTitle !== newTitle) {
      out.push({ kind: kind, idKey: idKey, id: item[idKey], labels: labels, oldTitle: oldTitle, newTitle: newTitle });
    }
  });
}

function applyTitleReplacement_(summary, replacement) {
  let out = summary;
  (replacement.labels || []).forEach((label) => {
    const oldNeedle = label + '「' + replacement.oldTitle + '」';
    const newNeedle = label + '「' + replacement.newTitle + '」';
    out = out.split(oldNeedle).join(newNeedle);
  });
  return out;
}

function applyTitleReplacementsToLog_(logItems, replacements) {
  return (logItems || []).map((item) => {
    let summary = String(item.summary || '');
    (replacements || []).forEach((replacement) => {
      summary = applyTitleReplacement_(summary, replacement);
    });
    return Object.assign({}, item, { summary: summary });
  });
}

function applyTitleReplacementsToSnapshot_(snapshot, replacements) {
  const copy = JSON.parse(JSON.stringify(snapshot || {}));
  const collectionMap = {
    activity: { key: 'activityArticles', idKey: 'articleId' },
    request: { key: 'requestCases', idKey: 'caseId' },
    exhibition: { key: 'exhibitions', idKey: 'exhibitionId' }
  };
  (replacements || []).forEach((replacement) => {
    const target = collectionMap[replacement.kind];
    if (!target || !Array.isArray(copy[target.key])) return;
    copy[target.key].forEach((item) => {
      if (item && item[target.idKey] === replacement.id) item.title = replacement.newTitle;
    });
  });
  return copy;
}

function deriveSiteHistoryEntries_(baseLog, state, pendingSummary) {
  const visible = buildVisibleTitleSets_(state || {});
  const entries = [];
  if (pendingSummary) entries.push({ timestamp: isoNow_(), summary: pendingSummary });
  (baseLog || []).forEach((item) => entries.push(item));

  const groups = [];
  const groupIndex = {};
  entries.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))).forEach((entry) => {
    const dateKey = formatHistoryDate_(entry.timestamp);
    if (!groupIndex[dateKey]) {
      groupIndex[dateKey] = { date: dateKey, items: [], seen: {} };
      groups.push(groupIndex[dateKey]);
    }
    splitSummarySegments_(entry.summary).forEach((segment) => {
      const key = publicSegmentKey_(segment);
      let keep = false;
      let normalized = segment;
      if (key.kind === 'recruit') {
        keep = true;
        normalized = canonicalPublicSummary_('recruit');
      } else if (key.kind && key.title) {
        keep = !!(visible[key.kind] && visible[key.kind][key.title]);
        normalized = canonicalPublicSummary_(key.kind, key.title);
      } else if (!key.kind) {
        keep = !!segment;
      }
      if (keep && !groupIndex[dateKey].seen[normalized]) {
        groupIndex[dateKey].seen[normalized] = true;
        groupIndex[dateKey].items.push(normalized);
      }
    });
  });
  return groups.filter((entry) => entry.items.length).map((entry) => ({ date: entry.date, items: entry.items }));
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

function buildVisibleTitleSets_(state) {
  const out = { activity: {}, request: {}, exhibition: {} };
  (state.activityArticles || []).filter((item) => item.published !== false && item.title).forEach((item) => out.activity[String(item.title)] = true);
  (state.requestCases || []).filter((item) => item.published !== false && item.title).forEach((item) => out.request[String(item.title)] = true);
  (state.exhibitions || []).filter((item) => item.published !== false && item.title).forEach((item) => out.exhibition[String(item.title)] = true);
  return out;
}

function splitSummarySegments_(summary) {
  const normalized = String(summary || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.indexOf('\n') !== -1) return normalized.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const legacyParts = normalized.split(/\s\/\s/).map((part) => part.trim()).filter(Boolean);
  if (legacyParts.length > 1 && legacyParts.every(looksLegacySummarySegment_)) return legacyParts;
  return [normalized];
}

function looksLegacySummarySegment_(segment) {
  return segment === '新歓イベントカレンダーを更新'
    || /^(活動記事|活動記録・告知|ご依頼事例|取り組み事例|取り組み)「.+?」(?:を追加|を更新|の情報を公開)?$/.test(segment)
    || /^展示会「.+?」(?:を追加|を更新|の情報を公開)?$/.test(segment);
}

function publicSegmentKey_(segment) {
  if (segment === '新歓イベントカレンダーを更新') return { kind: 'recruit', title: '' };
  let match = segment.match(/^(活動記事|活動記録・告知)「(.+?)」(?:を追加|を更新|の情報を公開)?$/);
  if (match) return { kind: 'activity', title: match[2] };
  match = segment.match(/^(ご依頼事例|取り組み事例|取り組み)「(.+?)」(?:を追加|を更新|の情報を公開)?$/);
  if (match) return { kind: 'request', title: match[2] };
  match = segment.match(/^展示会「(.+?)」(?:を追加|を更新|の情報を公開)?$/);
  if (match) return { kind: 'exhibition', title: match[1] };
  return { kind: '', title: '' };
}

function canonicalPublicSummary_(kind, title) {
  if (kind === 'recruit') return '新歓イベントカレンダーを更新';
  if (kind === 'activity' && title) return '活動記録・告知「' + title + '」';
  if (kind === 'request' && title) return '取り組み「' + title + '」';
  if (kind === 'exhibition' && title) return '展示会「' + title + '」の情報を公開';
  return title || '';
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
