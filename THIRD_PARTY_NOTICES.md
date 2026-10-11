# Third-party packaging notices

This fork derives its Flatpak packaging from
[rulin132/chatgpt-flatpak](https://github.com/rulin132/chatgpt-flatpak).
Its original MIT packaging license is retained in [LICENSE](LICENSE):

> Copyright (c) 2026 the chatgpt-flatpak contributors

The experimental outbound Remote adaptation references the design in
[ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux),
initially reviewed at `49d5bc1c38aba9d25c1c798c1fffad8918390ae1`.
The following notice is preserved for that project:

```text
MIT License

Copyright (c) 2025 ilysenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

These notices cover community packaging and adaptations only. The OpenAI
application is fetched by the end user as extra-data and is governed by its
own terms. See [the Remote adaptation](README.md#control-other-devices-experimental)
for the component boundaries and local implementation details.
