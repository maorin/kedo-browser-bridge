import { Readability } from '@mozilla/readability';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'extract_readable') return false;

  try {
    const cloned = document.cloneNode(true) as Document;
    const article = new Readability(cloned).parse();
    const selection = window.getSelection()?.toString().trim() || null;

    sendResponse({
      title: article?.title || document.title,
      text_content: article?.textContent?.trim() || '',
      excerpt: article?.excerpt || null,
      length: article?.length || 0,
      selection,
    });
  } catch (err) {
    sendResponse({ error: String(err) });
  }
  return true;
});
