chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'quick-add-tag') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0] || !tabs[0].url || tabs[0].url.startsWith('chrome')) return;
      chrome.storage.local.set({ quickAddPage: { url: tabs[0].url, title: tabs[0].title || '', ts: Date.now() } }, () => {
        chrome.action.openPopup();
      });
    });
  }
});
