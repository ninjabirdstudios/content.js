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

Notes Dump
----------

01. Create ContentLoader 'loader' that runs on the UI thread.
    var loader = ContentJS.createLoader({
        application       : 'foo',
        platform          : 'ps3',
        version           : 'latest',
        background        :  true,
        servers           : [
            'https://foo.bar.com/content',
            'https://foo.car.com/content'
        ]
    });
02. Subscribe to events. Note that there's no 'progress' event. Instead
    the client will want to poll for the progress of each package.
    loader.on('error', onContentLoaderError(loader, error));
03. Reload the application manifest with:
    loader.loadApplicationManifest();
04. [Internal] Once the manifest has finished downloading:
    Reset the progress for all packages to zero.
    Parse the application manifest file.
    Emit a 'manifest:loaded' event.
05. Once the application manifest has been loaded ('manifest:loaded')
    the client can request that groups of packages be loaded:
    loader.loadPackage(name, set)
    loader.loadPackageGroup(groupName, set, [
        'core',
        'preload',
        'level01'
    ]);
06. [Internal] Each one of the package names gets queued for download.
    The ContentServer will report 'progress' and 'resource' events.
    The 'progress' event should update the package status and emit a
    'package:progress' event so the client can poll download status.
    The 'resource' event should add the data to a queue and trigger the
    unpack process (if it's not already in-progress.) Unpacking is done
    one package at a time. Should also emit a 'package:download' event
    that specifies the group name and the package name.
07. Unpacking consists of loading the package.manifest entry within the
    archive file, and then for each resource within the package:
    - Create an internal record to represent it. Load state, etc. can
      be tracked here. Metadata is available as manifest.resources[i]
      with fields name, type, tags[], data[].
    - Pass it off to the registered handler for the resource type,
      probably via an event, like so:
      loader.on('atlas', function (metadata, archive, content, context)
          {
              var resourceName = metadata.name;
              var atlasFile    = Content.fileWithExtension('atlas', metadata);
              var imageFile    = Content.fileWithExtension('image', metadata);
              var atlasData    = Content.loadObject(atlasFile, archive);
              var imageData    = Content.loadPixels(imageFile, archive);
              var video        = Content.loadVideo(...);
              var audio        = Content.loadAudio(...);
              var canvas       = Content.loadCanvas(...);
              content.loaded   = true;
              content.runtime  = {
                  atlas        : atlasData,
                  texture      : context.createTexture(image)
              };
          });
    - Emit a 'resource:loaded' event.
    - Decrement the number of pending resources.
08. When all packages in a group have been unpacked, the ContentSet
    should emit a 'complete' event to indicate that it is ready for use.
    Client code should store resource references as handles
09. All of this should work in a time-slice fashion, where the
    loader.update() function is called once per-frame and takes up
    approximately the requested amount of time, or less.
10. SEE http://www.html5rocks.com/en/tutorials/webgl/typed_arrays/

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
