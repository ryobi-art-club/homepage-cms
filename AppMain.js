// 画面を返す入口（doGet）と、画面のファイルの埋め込み

const APP_NAME = '凌美会 管理画面';

function doGet() {
  return HtmlService.createTemplateFromFile('Ui')
    .evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
