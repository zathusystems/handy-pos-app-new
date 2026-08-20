export const downloadTextFile = (
  content: string,
  filename: string,
  mimeType = 'text/csv;charset=utf-8;'
): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (error) {
    console.error('[Download] Failed to trigger file download:', error);
    return false;
  }
};
