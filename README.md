# Gemini TTS Reader Chrome Extension

A lightweight and easy-to-use Chrome extension that uses the Google Gemini API for high-quality text-to-speech (TTS) conversion. Select any text on a webpage, and let the extension read it aloud for you.

## ✨ Features

- **High-Quality TTS**: Leverages Google's Gemini 2.5 Flash model for natural-sounding audio
- **Simple to Use**: Right-click on selected text or use keyboard shortcut to start reading
- **Floating Control Bar**: Draggable on-page widget to play/pause, skip, and control playback speed
- **Robust & Modern**: Built with Manifest V3, ensuring it meets the latest Chrome extension standards
- **Secure**: Your API key is stored locally and securely, never shared

## 🚀 How to Install and Use

### Prerequisites
- Chrome browser (version 88+)
- Google Generative AI API key ([Get one here](https://aistudio.google.com/app/apikey))

### Installation Steps

1. **Clone or Download**: Get a local copy of this repository
2. **Install Dependencies**: Open your terminal in the project folder and run `npm install`
3. **Load the Extension**:
   - Open Chrome and navigate to `chrome://extensions`
   - Enable "Developer mode" in the top right corner
   - Click "Load unpacked" and select the project folder
4. **Set Your API Key**:
   - Click on the extension's icon in your Chrome toolbar and go to "Options"
   - Enter your Google Generative AI API key
5. **Start Reading**:
   - Select any text on a webpage
   - Right-click and choose "Read selected text" from the context menu
   - Alternatively, use the keyboard shortcut `Alt+Shift+R`

## 🛠️ Development & Testing

This project uses Jest for testing:

```bash
npm test           # Run tests once
npm test --watch   # Run tests in watch mode
```

## 🗺️ Roadmap & Known Issues

This is an actively developed project. Future improvements and areas of focus include:

- **Handling Long Texts**: Improve management of implicit audio truncation from the API for very long texts
- **State Persistence**: Better state management across multiple tabs and recovery from page reloads/crashes  
- **UI/UX Enhancements**: Fallbacks for pages where the side panel cannot be injected (e.g., popups or notifications)
- **Logging**: Implement an option for on-demand, detailed logging for easier debugging

## 📄 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
