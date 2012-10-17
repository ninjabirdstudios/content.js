content.js
==========

A JavaScript client companion library to node-contentjs. This library can load
package files (tar format) output by the node-contentjs publish tool. It uses
the information stored in the package.manifest files to build a runtime set of
content that can be accessed by name, and allows for easy asset replacement.

Additionally, code is included to manage the downloading of these manifest and
package files. The HTML5 IndexedDB and WebSQL APIs are used to cache downloaded
packages on the client, speeding load times while still allowing for content
updates.

Finally, a developer toolbar is included that can be added to games or media
applications and works with the services provided by node-contentjs-tool to
allow for content changes to be detected and the corresponding package files
reloaded automatically.

Upcoming Changes
----------------

Support for the WebSQL API will be dropped if Safari and Mobile Safari ever
implement IndexedDB support.

License
-------

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this
software, either in source code form or as a compiled binary, for any purpose,
commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this
software dedicate any and all copyright interest in the software to the public
domain. We make this dedication for the benefit of the public at large and to
the detriment of our heirs and successors. We intend this dedication to be an
overt act of relinquishment in perpetuity of all present and future rights to
this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>
