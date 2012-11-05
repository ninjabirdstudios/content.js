/*/////////////////////////////////////////////////////////////////////////////
/// @summary Implements a small runtime library to manage the download, caching
/// and extraction of content files packaged into tar archives.
/// @author Russell Klenk (russ@ninjabirdstudios.com)
///////////////////////////////////////////////////////////////////////////80*/
var ContentJS = (function (exports)
{
    /// Defines the command identifiers for commands that can be sent from the
    /// ContentServer to ContentClient.
    var ClientCommand  = {
        /// Indicates that an error occurred. The message object has the
        /// following fields:
        /// msg.error: A string message specifying additional information.
        ERROR          : 0,
        /// Indicates that a cache is ready for use by the client. The message
        /// object has the following fields:
        /// msg.name: The string name of the application cache ready for use.
        CACHE_READY    : 1,
        /// Reports completion progress on a resource download operation. The
        /// message object has the following fields:
        /// msg.requestId: The client identifier for the request, as specified
        /// on the ServerCommand.GET_RESOURCE message.
        /// msg.progress: A Number specifying a percentage of completion. This
        /// value is an integer in the range [0, 100].
        PROGRESS       : 2,
        /// Reports that the data for a resource has been successfully
        /// retrieved. The message object has the following fields:
        /// msg.requestId: The client identifier for the request, as specified
        /// on the ServerCommand.GET_RESOURCE message.
        /// msg.resourceUrl: The URL from which the resource was loaded.
        /// msg.resourceName: The relative path and filename of the resource.
        /// msg.resourceData: The resource data object. The type of this field
        /// depends on the requested resource type.
        /// msg.resourceType: The requested resource type. Will be one of
        /// 'blob', 'json', 'text', 'document' or 'arraybuffer'.
        RESOURCE_DATA  : 3
    };

    /// Defines the command identifiers for commands that can be sent from the
    /// ContentClient to ContentServer.
    var ServerCommand  = {
        /// Adds a server to the list of servers that provide content to the
        /// client. The message object should have a the following fields:
        /// msg.url: The string specifying the server URL to add.
        ADD_SERVER     : 0,
        /// Removes a server from the list of servers that provide content to
        /// the client. The message object should have the following fields:
        /// msg.url: The string specifying the server URL to remove.
        REMOVE_SERVER  : 1,
        /// Opens a named data cache that can be used to cache data on the
        /// client. The message object should have the following fields:
        /// msg.name: The string name of the application cache.
        OPEN_CACHE     : 2,
        /// Deletes all data cached under a given identifier. If the cache is
        /// currently open, it is closed and then deleted. The message object
        /// should have the fields:
        /// msg.name: The string name of the application cache.
        DELETE_CACHE   : 3,
        /// Requests a resource. The message object should have the fields:
        /// msg.requestId: An application-defined identifier for the request.
        /// msg.cacheName: A string specifying the name of the opened, ready
        /// cache. This value is required and cannot be empty.
        /// msg.preferredServer: A string specifying the preferred server. If
        /// not present, the server with the lowest estimated load value is
        /// selected to service the request.
        /// msg.resourceName: A string specifying the relative path and
        /// filename of the resource to request. This value is required and
        /// cannot be empty.
        /// msg.responseType: A string specifying the desired interpretation of
        /// the data returned by the server. May be one of 'blob', 'json',
        /// 'text', 'document' or 'arraybuffer'. The default is 'arraybuffer'.
        /// msg.returnCached: A boolean value. If true, and the resource exists
        /// in the cache, the cached copy is returned. If false, the resource
        /// is always downloaded from the network.
        GET_RESOURCE   : 4
    };

    /// Defines the states in the process of unpacking a resource package.
    var UnpackState    = {
        /// Indicates that the resource package data has been fully downloaded
        /// and needs to be parsed by the TarArchive.parse() method.
        PARSE_ARCHIVE  : 0,
        /// Indicates that the package resources are being extracted and
        /// converted to runtime objects.
        LOAD_RESOURCES : 1,
        /// Indicates that the unpacking process completed successfully.
        COMPLETE       : 2,
        /// Indicates that the unpacking process completed with an error.
        ERROR          : 3
    };

    /// Polyfills for the underlying storage APIs.
    var StorageAPI     = {
        /// The resolved version of window.indexedDB (for IndexedDB.)
        indexedDB      : null,
        /// The resolved version of window.IDBTransaction (for IndexedDB.)
        IDBTransaction : null,
        /// The resolved version of window.IDBTransaction.READ_ONLY.
        READ_ONLY      : null,
        /// The resolved version of window.IDBTransaction.READ_WRITE.
        READ_WRITE     : null
    };

    StorageAPI.indexedDB = (function ()
        {
            return  window.indexedDB              ||
                    window.oIndexedDB             ||
                    window.msIndexedDB            ||
                    window.mozIndexedDB           ||
                    window.webkitIndexedDB;
        })();

    StorageAPI.IDBTransaction = (function ()
        {
            return  window.IDBTransaction         ||
                    window.oIDBTransaction        ||
                    window.msIDBTransaction       ||
                    window.mozIDBTransaction      ||
                    window.webkitIDBTransaction;
        })();

    StorageAPI.READ_ONLY  = StorageAPI.IDBTransaction.READ_ONLY  || 'readonly';
    StorageAPI.READ_WRITE = StorageAPI.IDBTransaction.READ_WRITE || 'readwrite';

    /// A handy utility function that prevents having to write the same
    /// obnoxious code everytime. The typical javascript '||' trick works for
    /// strings, arrays and objects, but it doesn't work for booleans or
    /// integer values.
    /// @param value The value to test.
    /// @param theDefault The value to return if @a value is undefined.
    /// @return Either @a value or @a theDefault (if @a value is undefined.)
    function defaultValue(value, theDefault)
    {
        return (value !== undefined) ? value : theDefault;
    }

    /// Constructor for the Emitter class, which adds EventEmitter-like
    /// functionality for JavaScript in the browser. The Emitter class is not
    /// generally used directly, instead you Emitter.mixin(yourClass).
    var Emitter = function () {};

    /// Adds the methods of the Emitter type to the prototype of another type.
    /// @param target The constructor function of the target type.
    Emitter.mixin = function (target)
    {
        var props  = ['on','removeListener','removeAllListeners','emit'];
        for (var i = 0, n = props.length; i < n; ++i)
            target.prototype[props[i]] = Emitter.prototype[props[i]];
    };

    /// Registers an event listener for a named event.
    /// @param event A String specifying the name of the event to listen for.
    /// @param callback The callback function to register.
    /// @return A reference to the calling context.
    Emitter.prototype.on = function (event, callback)
    {
        this.eventListeners        = this.eventListeners        || {};
        this.eventListeners[event] = this.eventListeners[event] || [];
        this.eventListeners[event].push(callback);
        return this;
    };

    /// Removes a specific event listener.
    /// @param event A String specifying the name of the event for which the
    /// specified callback is registered.
    /// @param callback The callback function to remove.
    /// @return A reference to the calling context.
    Emitter.prototype.removeListener = function (event, callback)
    {
        this.eventListeners = this.eventListeners || {};
        var listener = this.eventListeners[event];
        if (listener)  listener.splice(listener.indexOf(callback), 1);
        return this;
    };

    /// Removes all listeners for a given event.
    /// @param event A String specifying the name of the event for which all
    /// registered listeners will be removed.
    /// @return A reference to the calling context.
    Emitter.prototype.removeAllListeners = function (event)
    {
        this.eventListeners          = this.eventListeners || {};
        this.eventListeners[event]   = [];
        return this;
    };

    /// Emits a named event, immediately invoking all registered listeners. Any
    /// additional arguments aside from @a event are passed to the listeners.
    /// @param event A String specifying the name of the event being raised.
    /// @return A reference to the calling context.
    Emitter.prototype.emit = function (event)
    {
        this.eventListeners = this.eventListeners || {};
        var listener        = this.eventListeners[event];
        if (listener)
        {
            var count  = arguments.length;
            switch (count)
            {
                case 1:
                    {
                        for (var i = 0, n = listener.length; i < n; ++i)
                            listener[i].call(this);
                    }
                    break;
                case 2:
                    {
                        for (var i = 0, n = listener.length; i < n; ++i)
                            listener[i].call(this, arguments[1]);
                    }
                    break;
                case 3:
                    {
                        for (var i = 0, n = listener.length; i < n; ++i)
                            listener[i].call(this, arguments[1], arguments[2]);
                    }
                    break;
                default:
                    {
                        var args   = Array.prototype.slice.call(arguments, 1);
                        for (var i = 0, n = listener.length; i < n; ++i)
                            listener[i].apply(this, args);
                    }
                    break;
            }
        }
        return this;
    };

    /// An object defining the various types of records that may be found within
    /// a tar archive file in the ustar format.
    var TarEntry  = function () {
        if (!(this instanceof TarEntry))
        {
            return new TarEntry();
        }
        this.metaOffset = 0;    // byte offset of the start of the header
        this.dataOffset = 0;    // byte offset of the start of the data
        this.name       = null; // a string; the name of the entry
        this.mode       = 0;    // mode flags associated with the entry
        this.uid        = 0;    // owner user ID
        this.gid        = 0;    // owner group ID
        this.size       = 0;    // size of the entry data, in bytes
        this.mtime      = 0;    // the file modification time
        this.checksum   = 0;    // checksum of the header data
        this.type       = TarEntry.FILE; // the type of record
        this.linkName   = null; // a string; the name of the linked file
        this.magic      = null; // a string; should always be 'ustar'
        this.version    = 0;    // the ustar version, typically zero
        this.userName   = null; // a string; the username of the owner
        this.groupName  = null; // a string; the group name of the owner
        return this;
    };

    /// The record represents an actual file.
    TarEntry.FILE      = 0;

    /// The record represents a hard link.
    TarEntry.HARDLINK  = 1;

    /// The record represents a symbolic link.
    TarEntry.SYMLINK   = 2;

    /// The record represents a character device.
    TarEntry.CHARACTER = 3;

    /// The record represents a block device.
    TarEntry.BLOCK     = 4;

    /// The record represents a directory.
    TarEntry.DIRECTORY = 5;

    /// The record represents a named pipe.
    TarEntry.FIFO      = 6;

    /// Constructor function for a type that represents the contents of a ustar
    /// tar archive file. All operations execute synchronously.
    /// @return A reference to the new TarArchive.
    var TarArchive = function ()
    {
        if (!(this instanceof TarArchive))
        {
            return new TarArchive();
        }
        this.buffer     = null; // the underlying ArrayBuffer
        this.view       = null; // A Uint8Array for the entire archive
        this.entryList  = [];   // list of files for access by index
        this.entryTable = {};   // table of entries for access by name
        return this;
    };

    /// 2^9 = 512 which corresponds to the block size. If the block size is
    /// changed then this constant must also be adjusted.
    TarArchive.BLOCK_SHIFT = 9;

    /// A constant specifying the block size to which all entry data is
    /// rounded up.
    TarArchive.BLOCK_SIZE  = 512;

    /// A constant specifying the size of a header entry, in bytes.
    TarArchive.HEADER_SIZE = 512;

    /// Checks an archive entry record to determine whether it indicates a
    /// standard file entry (hard links and symbolic links are not included.)
    /// @param entry The archive header entry to inspect.
    /// @return true if the entry indicates a normal file.
    TarArchive.prototype.isFile = function (entry)
    {
        return (TarEntry.FILE  == entry.type);
    };

    /// Checks an archive entry record to determine whether it indicates a
    /// directory entry.
    /// @param entry The archive header entry to inspect.
    /// @return true if the entry indicates a directory.
    TarArchive.prototype.isDirectory = function (entry)
    {
        var l = entry.name.length - 1;
        return (TarEntry.DIRECTORY  == entry.type || entry.name[l] == '/');
    };

    /// Checks an archive entry record to determine whether it indicates the
    /// end of the archive. Tar archives are terminated with two entries of
    /// zero bytes.
    /// @param entry The archive header entry to inspect.
    /// @return true if the entry indicates the end of the archive.
    TarArchive.prototype.isEndOfArchive = function (entry)
    {
        return (null == entry.name || 0 == entry.name.length);
    };

    /// Computes the byte offset of the next record given the offset and size
    /// of the data for the previous entry.
    /// @param dataOffset The byte offset of the data for the previous entry.
    /// @param dataSize The size of the previous entry, in bytes.
    TarArchive.prototype.nextHeaderOffset = function (dataOffset, dataSize)
    {
        var ss = Math.ceil(dataSize >> TarArchive.BLOCK_SHIFT);
        return dataOffset + ss * TarArchive.BLOCK_SIZE;
    };

    /// Reads @a length ASCII characters (each one byte) from the buffer
    /// starting at @a offset and returns the result as a string.
    /// @param view The Uint8Array from which data will be read.
    /// @param offset The byte offset at which to begin reading data.
    /// @param length The number of bytes to read.
    /// @return A string initialized with the data read.
    TarArchive.prototype.readString = function (view, offset, length)
    {
        var s  = '';
        var e  = offset + length;
        for (var i = offset; i < e; ++i)
        {
            var c  = view[i];
            if (c == 0) break;
            s += String.fromCharCode(c);
        }
        return  s;
    };

    /// Reads @a length ASCII characters (each one byte) from the buffer
    /// starting at @a offset, interpreting them as octal digits.
    /// @param view The Uint8Array from which data will be read.
    /// @param offset The byte offset at which to begin reading data.
    /// @param length The number of bytes to read.
    /// @return A number set to the value read.
    TarArchive.prototype.readOctal = function (view, offset, length)
    {
        var n  = 0;
        var e  = offset + length;
        for (var i = offset; i < e; ++i)
        {
            var c  = view[i];
            if (c >= 48 && c < 56)
            {
                n *= 8;
                n += c - 48;
            }
        }
        return  n;
    };

    /// Reads a single header entry from the buffer starting at the specified
    /// byte offset.
    /// @param view The Uint8Array from which data will be read.
    /// @param offset The byte offset at which to begin reading data.
    TarArchive.prototype.readHeader = function (view, offset)
    {
        var o        = offset;
        var rs       = this.readString;
        var rn       = this.readOctal;
        var e        = new TarEntry();
        e.metaOffset = offset;
        e.dataOffset = offset + TarArchive.HEADER_SIZE;
        e.name       = rs(view, o, 100); o += 100;
        e.mode       = ro(view, o,   8); o +=   8;
        e.uid        = ro(view, o,   8); o +=   8;
        e.gid        = ro(view, o,   8); o +=   8;
        e.size       = ro(view, o,  12); o +=  12;
        e.mtime      = ro(view, o,  12); o +=  12;
        e.checksum   = ro(view, o,   8); o +=   8;
        e.type       = ro(view, o,   1); o +=   1;
        e.linkName   = rs(view, o, 100); o += 100;
        e.magic      = rs(view, o,   6); o +=   6;
        if (e.magic == 'ustar')
        {
            // this is a ustar archive, read the additional fields.
            e.version     = ro(view, o,   2); o +=   2;
            e.userName    = rs(view, o,  32); o +=  32;
            e.groupName   = rs(view, o,  32); o +=  32;
            e.deviceMajor = ro(view, o,   8); o +=   8;
            e.deviceMinor = ro(view, o,   8); o +=   8;
            e.prefix      = rs(view, o, 155); o += 155;
        }
        else
        {
            // this isn't a ustar archive; it may just be plain tar.
            e.version     = 0;
            e.userName    = '';
            e.groupName   = '';
            e.deviceMajor = 0;
            e.deviceMinor = 0;
            e.prefix      = '';
        }
        return e;
    };

    /// Parses the contents of a tar archive to extract information about the
    /// entries contained within the archive.
    /// @param types An array of values from TarEntry specifying the types of
    /// archive entries to include in the entry list.
    /// @param buffer An ArrayBuffer instance containing the archive data.
    /// @param byteOffset The zero-based byte offset within @a buffer at which
    /// the tar archive begins. If unspecified, this value defaults to zero.
    /// @param byteLength The size of the tar archive, in bytes. If
    /// unspecified, this value defaults to the byte length of @a buffer.
    /// @return A reference to the TarArchive instance.
    TarArchive.prototype.parse = function (types, buffer, byteOffset, byteLength)
    {
        if (!types)  types  = [];
        if (!buffer) buffer = new ArrayBuffer(0);

        // default the byteOffset and byteLength arguments.
        byteOffset = defaultValue(byteOffset, 0);
        byteLength = defaultValue(byteLength, buffer.byteLength);

        // initialize our view of the archive to empty.
        this.buffer     = buffer;
        this.view       = new Uint8Array(buffer, byteOffset, byteLength);
        this.entryList  = [];
        this.entryTable = {};

        // define a simple function to filter an entry by type.
        var    filter = function (e, t)
            {
                var n = t.length;
                for (var i = 0; i < n; ++i)
                {
                    if (e.type == t[i])
                        return true;
                }
                return false;
            };

        // parse the archive format into entries.
        var    end    = this.isEndOfArchive;
        var    headSz = TarArchive.HEADER_SIZE;
        var    offset = 0;
        while (offset < byteLength)
        {
            var entry = this.readHeader(this.view, offset);
            offset    = this.nextHeaderOffset(entry.dataOffset, entry.size);
            if (end(entry) == false && filter(entry, types))
            {
                // add this entry to our internal lists.
                var k = entry.prefix + entry.name;
                this.entryList.push(entry);
                this.entryTable[k]= entry;
            }
        }
        return this;
    }

    /// Retrieves an entry by name (path).
    /// @param name The name (path) of the entry to locate.
    /// @return A reference to the specified entry, or undefined.
    TarArchive.prototype.getEntryByName = function (name)
    {
        return this.entryTable[name];
    };

    /// Retrieves an entry by index.
    /// @param index The zero-based index of the entry to retrieve.
    /// @return A reference to the specified entry.
    TarArchive.prototype.getEntryByIndex = function (index)
    {
        return this.entryList[index];
    };

    /// Retrieves a DataView view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return A DataView view of the data associated with @a entry.
    TarArchive.prototype.dataAsDataView = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new DataView(this.buffer, offset, entry.size);
    }

    /// Retrieves an Int8Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return An Int8Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsInt8Array = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new Int8Array(this.buffer, offset, entry.size);
    }

    /// Retrieves a Uint8Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return A Uint8Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsUint8Array = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new Uint8Array(this.buffer,  offset, entry.size);
    };

    /// Retrieves a Uint8ClampedArray view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return A Uint8ClampedArray view of the data associated with @a entry.
    TarArchive.prototype.dataAsUint8ClampedArray = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new Uint8Array(this.buffer,  offset, entry.size);
    };

    /// Retrieves an Int16Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return An Int16Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsInt16Array = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new Int16Array(this.buffer,  offset, entry.size);
    }

    /// Retrieves a Uint16Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return A Uint16Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsUint16Array = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new Uint16Array(this.buffer, offset, entry.size);
    };

    /// Retrieves an Int32Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return An Int32Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsInt32Array = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new Int32Array(this.buffer,  offset, entry.size);
    }

    /// Retrieves a Uint32Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return A Uint32Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsUint32Array = function (entry)
    {
        var offset = this.view.byteOffset + entry.dataOffset;
        return new Uint32Array(this.buffer, offset, entry.size);
    };

    /// Retrieves a Float32Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return A Float32Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsFloat32Array = function (entry)
    {
        var offset = this.view.byteOffset  + entry.dataOffset;
        return new Float32Array(this.buffer, offset, entry.size);
    }

    /// Retrieves a Float64Array view of the data associated with an entry.
    /// @param entry The entry for which the data is to be retrieved.
    /// @return A Float64Array view of the data associated with @a entry.
    TarArchive.prototype.dataAsFloat64Array = function (entry)
    {
        var offset = this.view.byteOffset  + entry.dataOffset;
        return new Float64Array(this.buffer, offset, entry.size);
    };

    /// Constructor function for an object representing a set of content.
    /// Content items are accessible by name or by index.
    /// @return A reference to the new ContentSet instance.
    var ContentSet = function ()
    {
        if (!(this instanceof ContentSet))
        {
            return new ContentSet();
        }
        return this;
    };
    Emitter.mixin(ContentSet);

    /// Represents a single outstanding cache request against a DataStore.
    /// @param store The DataStore instance that issued the request.
    /// @param key The name of the resource being requested. This is typically
    /// the path and filename to the resource.
    /// @param url A URL at which the resource is available if it is not
    /// located within the cache.
    /// @param type A string specifying the desired interpretation of the data
    /// returned by the server. May be one of 'blob', 'json', 'text',
    /// 'document' or 'arraybuffer'. An empty string corresponds to 'text'.
    /// @return The resource request object.
    var ResourceRequest = function (store, key, url, type)
    {
        if (!(this instanceof ResourceRequest))
        {
            return new ResourceRequest(store, key, url);
        }
        this.api     = StorageAPI;
        this.key     = key;
        this.url     = url;
        this.type    = type;
        this.store   = store;
        this.started = false;
        return this;
    };
    Emitter.mixin(ResourceRequest);

    /// Attempts to retrieve the resource from the underlying data store. If
    /// the resource is not present in the data store, the resource is
    /// requested from the server. If the resource is in the cache, the 'data'
    /// event is emitted with the data loaded from the cache.
    /// @return A reference to the ResourceRequest.
    ResourceRequest.prototype.queryDataStore = function ()
    {
        var self      = this;
        var db        = this.store.db;
        var api       = this.store.api;
        var txn       = db.transaction(DataStore.FILEDATA, api.READ_ONLY);
        var req       = txn.objectStore(DataStore.FILEDATA).get(this.key);
        req.onsuccess = function (e)
            {
                if (req.result !== undefined)
                {
                    // the resource is in the cache; return its data.
                    self.emit('data', self, req.result);
                }
                else
                {
                    // the resource is not in-cache; download and cache it.
                    self.downloadData();
                }
            };
        req.onerror   = function (e)
            {
                // the resource is not in the cache; download it.
                self.downloadData();
            };
        return this;
    };

    /// Attempts to cache downloaded data in the data store. Once the operation
    /// completes (whether it is successful or not) the 'data' event is emitted
    /// with the downloaded data; data is not re-loaded from the data store.
    /// @param info A ProgressEvent instance specifying the data size.
    /// @param data The resource data downloaded from the server.
    /// @return A reference to the ResourceRequest.
    ResourceRequest.prototype.cacheData = function (info, data)
    {
        var self = this;
        var db   = this.store.db;
        var api  = this.store.api;
        var txn  = db.transaction(DataStore.STORE_NAMES, api.READ_WRITE);
        var meta = {
            key      : this.key,
            type     : this.type,
            size     : info.total,
            modified : Date.now()
        };
        txn.objectStore(DataStore.METADATA).put(meta, this.key);
        txn.objectStore(DataStore.FILEDATA).put(data, this.key);
        txn.oncomplete = function (e)
            {
                // the data was written to the cache successfully.
                self.emit('data', self, data);
            };
        txn.onerror    = function (e)
            {
                // data couldn't be written to the cache. non-fatal.
                self.emit('data', self, data);
            };
        return this;
    };

    /// Attempts to download data from the server and cache it locally. If an
    /// error occurs, the 'error' event is emitted with information about the
    /// error; otherwise, 'progress' events are emitted as the download
    /// progresses. Once the download completes, the data is cached locally
    /// before the request is completed and the 'data' event emitted.
    /// @return A reference to the ResourceRequest.
    ResourceRequest.prototype.downloadData = function ()
    {
        var self          = this;
        var xhr           = new XMLHttpRequest();
        xhr.responseType  = this.type;
        xhr.open('GET',     this.url, true);
        xhr.onload        = function (e)
            {
                var stat  = xhr.status;
                if (stat >= 200 && stat < 300)
                {
                    // status codes in the 200 range indicate success.
                    self.cacheData(e, xhr.response);
                }
                else
                {
                    // status codes outside the 200 range indicate an error.
                    self.emit('error', self, xhr.statusText);
                }
            };
        xhr.onprogress   = function (e)
            {
                self.emit('progress', self, e);
            };
        xhr.onerror      = function (progress)
            {
                self.emit('error', self, xhr.statusText);
            };
        xhr.send();
        return this;
    };

    /// Executes the request if it has not already been started.
    /// @param checkCache Specify true to first check the cache for the
    /// requested data, or false to skip the cache and download the resource.
    /// @return A reference to the ResourceRequest.
    ResourceRequest.prototype.start = function (checkCache)
    {
        if (this.started)  return this;
        if (checkCache  != false)
        {
            // query the cache first, and download if not in-cache.
            this.started = true;
            this.queryDataStore();
        }
        else
        {
            // skip the cache check and immediately try downloading.
            this.started = true;
            this.downloadData();
        }
        return this;
    };

    /// Constructor function for the DataStore type backed by the indexedDB
    /// set of APIs. See http://www.w3.org/TR/IndexedDB/ for details.
    /// This type implements the Emitter interface.
    /// @param name The name of the application data store.
    var DataStore = function (name)
    {
        if (!(this instanceof DataStore))
        {
            return new DataStore(name);
        }
        this.api     = StorageAPI; // local alias for global StorageAPI
        this.db      = null;       // the indexedDB database connection
        this.name    = name;       // the name of the data store
        this.ready   = false;      // true if connected to database
        return this;
    };
    Emitter.mixin(DataStore);

    /// The current version of the database schema.
    DataStore.VERSION     = 1;

    /// The name of the IDBObjectStore for storing entry metadata.
    DataStore.METADATA    = 'metadata';

    /// The name of the IDBObjectStore for storing raw file data.
    DataStore.FILEDATA    = 'filedata';

    /// An array of object store names. Useful when creating transactions.
    DataStore.STORE_NAMES =
    [
        DataStore.METADATA,
        DataStore.FILEDATA
    ];

    /// Deletes all data stored in a particular data store instance by dropping
    /// the underlying database.
    /// @param name The name of the data store to delete.
    DataStore.deleteStore = function (name)
    {
        StorageAPI.indexedDB.deleteDatabase(name);
    };

    /// Creates the underlying IDBObjectStore instances within the data store.
    /// This is an internal function not intended for public use.
    /// @param db The IDBDatabase where the object stores will be created.
    DataStore.prototype.createStorageContainers = function (db)
    {
        db.createObjectStore(DataStore.METADATA);
        db.createObjectStore(DataStore.FILEDATA);
    };

    /// Handles the onupgradeneeded event raised when the database schema
    /// changes. This is an internal function not intended for public use.
    /// @param event An event conforming to IDBVersionChangeEvent interface.
    DataStore.prototype.handleUpgrade = function (event)
    {
        var  db = event.target.result;    // event.target is the open request.
        this.db = db;
        this.createStorageContainers(db);
    };

    /// Handles the onerror event raised when the database cannot be opened.
    /// This is an internal function not intended for public use.
    /// @param event An event conforming to the Event interface.
    DataStore.prototype.handleOpenError = function (event)
    {
        var err = event.target.error;    // event.target is the open request.
        this.emit('error', this, err);
    };

    /// Handles the onsuccess event raised when the database is opened.
    /// This is an internal function not intended for public use.
    /// @param event An event conforming to the Event interface.
    DataStore.prototype.handleOpenSuccess = function (event)
    {
        var  db = event.target.result;    // event.target is the open request.
        this.db = db;
        if  (db.setVersion && db.version != DataStore.VERSION)
        {
            // workaround for chrome which as of 08-31-12 only
            // supports onupgradeneeded in the dev channel...
            var self      = this;
            var req       = db.setVersion(DataStore.VERSION);
            req.onsuccess = function (e)
                {
                    self.version = req.newVersion || db.version;
                    self.createStorageContainers(db);
                    req.result.oncomplete = function ()
                        {
                            // @note: req.result is the versionchange txn.
                            // the version change transaction has completed.
                            self.ready = true;
                            self.emit('ready', self);
                        };
                };
            req.onerror   = function (e)
                {
                    self.emit('error', self, req.error);
                };
        }
        else
        {
            // no version upgrade was needed; we are finished.
            this.ready = true;
            this.emit('ready', this);
        }
    };

    /// Opens a connection to the data store. If an error occurs, the 'error'
    /// event is emitted. When the data store is ready, the 'ready' event is
    /// emitted.
    /// @return A reference to the DataStore instance.
    DataStore.prototype.open = function ()
    {
        var api             = this.api;
        var ver             = DataStore.VERSION;
        var req             = api.indexedDB.open(this.name, ver);
        req.onupgradeneeded = this.handleUpgrade.bind(this);
        req.onerror         = this.handleOpenError.bind(this);
        req.onsuccess       = this.handleOpenSuccess.bind(this);
        return this;
    };

    /// Closes the connection to the underlying data store. Any pending
    /// operations will complete before the connection is fully closed. Emits
    /// the 'closing' event to indicate that no new operations should be
    /// started.
    /// @return A reference to the IDBDataStore instance.
    DataStore.prototype.close = function ()
    {
        if (this.ready)
        {
            this.ready = false;
            this.emit('closing', this);
            if (this.db) this.db.close();
        }
    };

    /// Creates a request to resolve a resource against this data store. The
    /// request is not started.
    /// @param server The URL of the content server to download from if the
    /// requested resource does not exist in the data store.
    /// @param name The path and filename portion of the resource name.
    /// @param responseType A string specifying the desired interpretation of
    /// the data returned by the server. May be one of 'blob', 'json', 'text',
    /// 'document' or 'arraybuffer'. An empty string corresponds to 'text'.
    /// @return A ResourceRequest instance representing the request.
    DataStore.prototype.createRequest = function (server, name, responseType)
    {
        var url  = server;
        if (url.length > 0 && url[url.length-1] != '/')
            url += '/';
        url     += name;
        return new ResourceRequest(this, name, url, responseType);
    };

    /// Constructor function for the ContentServer type, which maintains global
    /// state for outstanding content requests and manages background
    /// downloading of data files.
    var ContentServer = function ()
    {
        if (!(this instanceof ContentServer))
        {
            return new ContentServer();
        }
        this.dataStores       = {};   // name => DataStore
        this.contentServers   = [];   // set of registered content server URLs
        this.addServer('');           // add a server representing our origin
        return this;
    };
    Emitter.mixin(ContentServer);

    /// Searches for a content server record based on the server URL.
    /// @param url A string specifying the root server URL.
    /// @return The server record, or null.
    ContentServer.prototype.findContentServer = function (url)
    {
        var list   = this.contentServers;
        var count  = list.length;
        for (var i = 0; i < count; ++i)
        {
            if (list[i].serverUrl == url)
                return list[i];
        }
        return null;
    };

    /// Adds a content server to the list of registered servers.
    /// @param url A string specifying the root server URL.
    /// @return A reference to the ContentServer instance.
    ContentServer.prototype.addContentServer = function (url)
    {
        if (this.findContentServer(url) == null)
        {
            this.contentServers.push({
                serverUrl : url,
                loadValue : 0
            });
        }
        return this;
    };

    /// Removes a content server from the list of registered servers.
    /// @param url A string specifying the root server URL.
    /// @return A reference to the ContentServer instance.
    ContentServer.prototype.removeContentServer = function (url)
    {
        var list   = this.contentServers;
        var count  = list.length;
        for (var i = 0; i < count; ++i)
        {
            if (list[i].serverUrl == url)
            {
                this.contentServers.splice(i, 1);
                return this;
            }
        }
        return this;
    };

    /// Selects a content server URL to use for a content download. The server
    /// with the lowest current load value is selected.
    /// @return An object with serverUrl and loadValue properties that
    /// represent the selected server.
    ContentServer.prototype.chooseContentServer = function ()
    {
        var list   = this.contentServers;
        var count  = list.length;
        var minid  = 0; // index of the item with the lowest load value
        for (var i = 0; i < count; ++i)
        {
            var lv = list[i].loadValue;
            if (lv == 0)
                return list[i];
            if (lv < minid)
                minid = i;
        }
        if (minid  < count)
            return list[minid];
        else
            return null;
    };

    /// Requests and begins loading a resource.
    /// @param args An object specifying the arguments associated with the
    /// GET_RESOURCE request.
    /// @param args.requestId An application-defined identifier for the
    /// request. This value will be sent back to the application when the
    /// request has completed and while it is in-progress.
    /// @param args.cacheName A string specifying the name of the opened and
    /// ready resource cache. If the cache is unknown or is not ready, an
    /// 'error' event is emitted.
    /// @param args.preferredServer An optional string value specifying the URL
    /// of the server the client prefers to use to satisfy the resource
    /// request. An empty string maps to the origin of the application. If this
    /// argument is not specified, the server with the lowest estimated load
    /// value is selected.
    /// @param args.resourceName A string specifying the relative path and
    /// filename of the resource being requested. The path is specified
    /// relative to the server URL registered previously.
    /// @param args.responseType A string specifying the desired interpretation
    /// of the data returned by the server. May be one of 'blob', 'json',
    /// 'text', 'document' or 'arraybuffer'. If unspecified, the default is
    /// 'arraybuffer'.
    /// @param args.returnCached A boolean value. If true, and the resource
    /// exists in the cache, the cached copy is returned. If false, the
    /// resource is always downloaded from the network.
    /// @return An instance of ResourceRequest representing the request.
    ContentServer.prototype.requestResource = function (args)
    {
        var requestId       = args.requestId;
        var cacheName       = args.cacheName;
        var preferredServer = args.preferredServer;
        var resourceName    = args.resourceName;
        var responseType    = args.responseType || 'arraybuffer';
        var returnCached    = args.returnCached;
        var dataStore       = this.dataStores[cacheName];
        var serverRecord    = null;
        var request         = null;

        if (!dataStore || !dataStore.ready)
        {
            var msg = 'Cache '+cacheName+' is not ready.';
            this.emit('error', this, msg, requestId);
            return null;
        }
        if (preferredServer)
        {
            // search for the preferred server. if not found, we will
            // choose the server with the lowest estimated load factor.
            serverRecord     = this.findContentServer(preferredServer);
        }
        serverRecord         = serverRecord || this.chooseContentServer();
        request              = dataStore.createRequest(
            serverRecord.serverUrl,
            resourceName,
            responseType);
        request.server       = serverRecord;
        request.clientId     = requestId;
        request.on('data',     this.handleRequestData.bind(this));
        request.on('error',    this.handleRequestError.bind(this));
        request.on('progress', this.handleRequestProgress.bind(this));
        // increase the load on the server that is satisfying the request,
        // and then start the request immediately.
        serverRecord.loadValue++;
        return request.start(returnCached);
    };

    /// Opens an existing named data store, or creates a new one if none with
    /// the specified name exists.
    /// @param name The name of the data store to create or open.
    /// @return A reference to the ContentServer.
    ContentServer.prototype.createDataStore = function (name)
    {
        var dataStore = this.dataStores[name];
        if (dataStore)  return this;
        dataStore = new DataStore(name);
        dataStore.on('ready',   this.handleDataStoreReady.bind(this));
        dataStore.on('error',   this.handleDataStoreError.bind(this));
        dataStore.on('closing', this.handleDataStoreClosing.bind(this));
        dataStore.open();
        return this;
    };

    /// Queues a data store for deletion. The data store is deleted in its
    /// entirety as soon as all open connections have been closed. If the data
    /// store is currently open, its connection is closed after any pending
    /// operations have been completed.
    /// @param name The name of the data store to close and delete.
    /// @return A reference to the ContentServer.
    ContentServer.prototype.deleteDataStore = function (name)
    {
        var dataStore = this.dataStores[name];
        if (dataStore)  dataStore.close();
        DataStore.deleteStore(name);
        return this;
    }

    /// Handles the notification from a DataStore that it is ready to be
    //// accessed for queries and caching.
    /// @param store The DataStore instance that raised the event.
    ContentServer.prototype.handleDataStoreReady = function (store)
    {
        // store the data store in our map.
        this.dataStores[store.name] = store;
        // emit the CACHE_READY message to notify the client.
        this.emit('message', this, {
            id    : ClientCommand.CACHE_READY,
            name  : store.name
        });
    };

    /// Handles the notification from a DataStore that an error occurred.
    /// @param store The DataStore instance that raised the event.
    /// @param error Information about the error that occurred.
    ContentServer.prototype.handleDataStoreError = function (store, error)
    {
        this.emit('error', this, error);
    };

    /// Handles the notification from a DataStore that it is closing and
    /// is no longer safe to access.
    /// @param store The DataStore instance that raised the event.
    ContentServer.prototype.handleDataStoreClosing = function (store)
    {
        // remove the named field from our map.
        // the next time someone tries to access
        // it, the store will be re-opened.
        delete this.dataStores[store.name];
    };

    /// Handles notification from a ResourceRequest instance that the data has
    /// been retrieved, either from the cache or from the server.
    /// @param req The ResourceRequest instance that raised the event.
    /// @param data The requested data. May be an Object, ArrayBuffer, etc.
    ContentServer.prototype.handleRequestData = function (req, data)
    {
        // the request has completed; no additional events will be received.
        req.removeAllListeners();
        // the request has completed, so decrease the server load estimate.
        req.server.loadValue--;
        // pass the data back to the client.
        this.emit('message', this, {
            id             : ClientCommand.RESOURCE_DATA,
            requestId      : req.clientId,
            resourceUrl    : req.url,
            resourceName   : req.key,
            resourceData   : data,
            resourceType   : req.type
        });
    };

    /// Handles notification from a ResourceRequest instance that an error
    /// occurred while downloading data from the server.
    /// @param req The ResourceRequest instance that raised the event.
    /// @param error Status text describing the error.
    ContentServer.prototype.handleRequestError = function (req, error)
    {
        // the request has completed; no additional events will be received.
        req.removeAllListeners();
        // the request has completed, so decrease the server load estimate.
        req.server.loadValue--;
        // pass the error back to the client.
        this.emit('error', this, error, req.clientId);
    };

    /// Handles notification from a ResourceRequest instance that progress has
    /// been made while downloading data from the server.
    /// @param req The ResourceRequest instance that raised the event.
    /// @param info A ProgressEvent instance containing download progress.
    ContentServer.prototype.handleRequestProgress = function (req, info)
    {
        var percent = 0;
        if (info && info.lengthComputable)
        {
            // compute an actual percentage value in [0, 100].
            percent = (info.loaded / info.total) * 100;
        }
        else
        {
            // Windows-style; jump to 99% and make them wait.
            percent = 99;
        }
        this.emit('message', this, {
            id             : ClientCommand.PROGRESS,
            requestId      : req.clientId,
            progress       : percent
        });
    };

    /// Handles a message received from a ContentClient instance.
    /// @param data The message data received from the client.
    ContentServer.prototype.handleClientMessage = function (data)
    {
        var IDs = ServerCommand;
        switch (data.id)
        {
            case IDs.ADD_SERVER:
                this.addServer(data.url);
                break;
            case IDs.REMOVE_SERVER:
                this.removeServer(data.url);
                break;
            case IDs.OPEN_CACHE:
                this.createDataStore(data.name);
                break;
            case IDs.DELETE_CACHE:
                this.deleteDataStore(data.name);
                break;
            case IDs.GET_RESOURCE:
                this.requestResource(data);
                break;
            default:
                break;
        }
    };

    /// Constructor function for a type that communicates with a content server
    /// running in the background as a Web Worker.
    /// @return A reference to the WorkerServer.
    var WorkerServer = function ()
    {
        if (!(this instanceof WorkerServer))
        {
            return new WorkerServer();
        }
        this.basePath   =  exports.scriptPath;
        this.workerFile = 'worker.js';
        this.workerPath =  this.basePath + this.workerFile;
        this.worker     =  null;
        return this;
    };
    Emitter.mixin(WorkerServer);

    /// Starts the content server running on a background thread.
    /// @return A reference to the WorkerServer.
    WorkerServer.prototype.startup = function ()
    {
        this.worker           = new Worker(this.workerPath);
        this.worker.onmessage = this.handleServerMessage.bind(this);
        return this;
    };

    /// Immediately terminates the content server and background thread. Any
    /// pending requests are cancelled.
    /// @return A reference to the WorkerServer.
    WorkerServer.prototype.shutdown = function ()
    {
        if (this.worker)
        {
            this.worker.terminate();
            this.worker = null;
        }
        return this;
    };

    /// Handles a message received from the content server's worker thread.
    /// This is an internal method that is not part of the public API.
    /// @param event An Event whose data field specifies the message object.
    WorkerServer.prototype.handleServerMessage = function (event)
    {
        var IDs = ClientCommand;
        var msg = event.data;
        switch (msg.id)
        {
            case IDs.ERROR:
                this.emit('error', msg);
                break;
            case IDs.CACHE_READY:
                this.emit('ready', msg);
                break;
            case IDs.PROGRESS:
                this.emit('progress', msg);
                break;
            case IDs.RESOURCE_DATA:
                this.emit('resource', msg);
                break;
            default:
                break;
        }
    };

    /// Adds a URL to the list of servers used for downloading application
    /// resources, allowing multiple resources to be downloaded in parallel.
    /// @param url The URL of the content server to add. If the origin is not
    /// the same as that of the requestor, the server must support CORS.
    WorkerServer.prototype.addServer = function (url)
    {
        this.worker.postMessage({
            id  : ServerCommand.ADD_SERVER,
            url : url
        });
    };

    /// Removes a URL from the list of servers used for downloading application
    /// resources. Pending requests against this server will not be cancelled.
    /// @param url The URL of the content server to remove.
    WorkerServer.prototype.removeServer = function (url)
    {
        this.worker.postMessage({
            id  : ServerCommand.REMOVE_SERVER,
            url : url
        });
    };

    /// Requests that a named application cache be opened or created. Caches
    /// are used for caching resources on the client. When the cache becomes
    /// available a 'ready' event is emitted.
    /// @param cacheName A string specifying the name of the application cache.
    WorkerServer.prototype.openCache = function (cacheName)
    {
        this.worker.postMessage({
            id   : ServerCommand.OPEN_CACHE,
            name : cacheName
        });
    };

    /// Requests that a named application cache have its current contents
    /// deleted. After deletion, resources will be requested from the server.
    /// @param cacheName A string specifying the name of the application cache.
    WorkerServer.prototype.deleteCache = function (cacheName)
    {
        this.worker.postMessage({
            id   : ServerCommand.DELETE_CACHE,
            name : cacheName
        });
    };

    /// Requests and begins loading a resource.
    /// @param args An object specifying the arguments associated with the
    /// GET_RESOURCE request.
    /// @param args.requestId An application-defined identifier for the
    /// request. This value will be sent back to the application when the
    /// request has completed and while it is in-progress.
    /// @param args.cacheName A string specifying the name of the opened and
    /// ready resource cache. If the cache is unknown or is not ready, an
    /// 'error' event is emitted.
    /// @param args.preferredServer An optional string value specifying the URL
    /// of the server the client prefers to use to satisfy the resource
    /// request. An empty string maps to the origin of the application. If this
    /// argument is not specified, the server with the lowest estimated load
    /// value is selected.
    /// @param args.resourceName A string specifying the relative path and
    /// filename of the resource being requested. The path is specified
    /// relative to the server URL registered previously.
    /// @param args.responseType A string specifying the desired interpretation
    /// of the data returned by the server. May be one of 'blob', 'json',
    /// 'text', 'document' or 'arraybuffer'. If unspecified, the default is
    /// 'arraybuffer'.
    /// @param args.returnCached A boolean value. If true, and the resource
    /// exists in the cache, the cached copy is returned. If false, the
    /// resource is always downloaded from the network.
    WorkerServer.prototype.requestResource = function (args)
    {
        this.worker.postMessage({
            id                  : ServerCommand.GET_RESOURCE,
            requestId           : args.requestId,
            cacheName           : args.cacheName,
            preferredServer     : args.preferredServer,
            resourceName        : args.resourceName,
            responseType        : args.responseType,
            returnCached        : args.returnCached
        });
    };

    /// Constructor function for a type that communicates with a content server
    /// running locally, on the same thread as the rest of the application.
    /// @return A reference to the LocalServer.
    var LocalServer = function ()
    {
        if (!(this instanceof LocalServer))
        {
            return new LocalServer();
        }
        this.server = null;
        return this;
    };
    Emitter.mixin(LocalServer);

    /// Performs any operations necessary to initialize the content server.
    /// @return A reference to the LocalServer.
    LocalServer.prototype.startup = function ()
    {
        this.server = new ContentServer();
        this.server.on('error',   this.handleError.bind(this));
        this.server.on('message', this.handleMessage.bind(this));
        return this;
    };

    /// Immediately terminates the content server and background thread.
    /// @return A reference to the LocalServer.
    LocalServer.prototype.shutdown = function ()
    {
        if (this.server)
        {
            this.server.removeAllListeners();
            this.server = null;
        }
        return this;
    };

    /// Adds a URL to the list of servers used for downloading application
    /// resources, allowing multiple resources to be downloaded in parallel.
    /// @param url The URL of the content server to add. If the origin is not
    /// the same as that of the requestor, the server must support CORS.
    LocalServer.prototype.addServer = function (url)
    {
        this.server.addContentServer(url);
    };

    /// Removes a URL from the list of servers used for downloading application
    /// resources. Pending requests against this server will not be cancelled.
    /// @param url The URL of the content server to remove.
    LocalServer.prototype.removeServer = function (url)
    {
        this.server.removeContentServer(url);
    };

    /// Requests that a named application cache be opened or created. Caches
    /// are used for caching resources on the client. When the cache becomes
    /// available a 'ready' event is emitted.
    /// @param cacheName A string specifying the name of the application cache.
    LocalServer.prototype.openCache = function (cacheName)
    {
        this.server.createDataStore(cacheName);
    };

    /// Requests that a named application cache have its current contents
    /// deleted. After deletiion, resources will be requested from the server.
    /// @param cacheName A string specifying the name of the application cache.
    LocalServer.prototype.deleteCache = function (cacheName)
    {
        this.server.deleteDataStore(cacheName);
    };

    /// Requests and begins loading a resource.
    /// @param args An object specifying the arguments associated with the
    /// GET_RESOURCE request.
    /// @param args.requestId An application-defined identifier for the
    /// request. This value will be sent back to the application when the
    /// request has completed and while it is in-progress.
    /// @param args.cacheName A string specifying the name of the opened and
    /// ready resource cache. If the cache is unknown or is not ready, an
    /// 'error' event is emitted.
    /// @param args.preferredServer An optional string value specifying the URL
    /// of the server the client prefers to use to satisfy the resource
    /// request. An empty string maps to the origin of the application. If this
    /// argument is not specified, the server with the lowest estimated load
    /// value is selected.
    /// @param args.resourceName A string specifying the relative path and
    /// filename of the resource being requested. The path is specified
    /// relative to the server URL registered previously.
    /// @param args.responseType A string specifying the desired interpretation
    /// of the data returned by the server. May be one of 'blob', 'json',
    /// 'text', 'document' or 'arraybuffer'. If unspecified, the default is
    /// 'arraybuffer'.
    /// @param args.returnCached A boolean value. If true, and the resource
    /// exists in the cache, the cached copy is returned. If false, the
    /// resource is always downloaded from the network.
    LocalServer.prototype.requestResource = function (args)
    {
        this.server.requestResource(args);
    };

    /// Handles an error event raised by the server.
    /// @param sender The ContentServer instance that raised the event.
    /// @param error A string describing the error.
    /// @param id The client-supplied request identifier.
    LocalServer.prototype.handleError = function (sender, error, id)
    {
        this.emit('error', {
            requestId : id,
            error     : error
        });
    };

    /// Handles a message event raised by the server.
    /// @param sender The ContentServer instance that raised the event.
    /// @param data The data associated with the message.
    LocalServer.prototype.handleMessage = function (sender, data)
    {
        var IDs = ClientCommand;
        switch (data.id)
        {
            case IDs.ERROR:
                this.emit('error', data);
                break;
            case IDs.CACHE_READY:
                this.emit('ready', data);
                break;
            case IDs.PROGRESS:
                this.emit('progress', data);
                break;
            case IDs.RESOURCE_DATA:
                this.emit('resource', data);
                break;
            default:
                break;
        }
    };

    /// Constructor function for the Content type, which represents a loaded
    /// (or loading) resource.
    /// @return A reference to the new Content instance.
    var Content = function ()
    {
        if (!(this instanceof Content))
        {
            return new Content();
        }
        this.metadata = metadata;
        return this;
    };

    /// Searches resource metadata to locate the first filename with a given
    /// file extension. The file extension is considered to be anything after
    /// the last occurrence of the period character.
    /// @param extension The extension string, without leading period.
    /// @param metadata The resource metadata object.
    /// @param metadata.data Array of filenames associated with the resource.
    /// @param startIndex The zero-based starting index. Defaults to zero.
    /// @return The filename of the first file with the specified extension, if
    /// any; otherwise, returns undefined.
    Content.fileWithExtension = function (extension, metadata, startIndex)
    {
        var separator = '.';
        var filenames = metadata.data;
        var fileCount = metadata.data.length;
        for (var i    = startIndex || 0; i < fileCount; ++i)
        {
            var lastP = filenames[i].lastIndexOf(separator);
            var ext   = filenames[i].substr(lastP + 1);
            if (ext === extension)
                return filenames[i];
        }
        // else, returns undefined.
    };

    /// Loads an object encoded as JSON from an archive entry.
    /// @param filename The filename corresponding to the archive entry.
    /// @param archive An instance of the TarArchive type.
    /// @param defaultValue The value to return if the object cannot be loaded.
    /// @return An object initialized from the JSON text, or @a defaultValue.
    Content.loadObject = function (filename, archive, defaultValue)
    {
        var entry = archive.getEntryByName(filename);
        if (entry)
        {
            var chars = archive.dataAsUint16Array(entry);
            var json  = String.fromCharCode.apply(null, chars);
            return JSON.parse(json);
        }
        return defaultValue;
    };

    /// Loads an image from a JSON entry and returns it as a new Canvas.
    /// @param filename The filename corresponding to the archive entry.
    /// @param archive An instance of the TarArchive type.
    /// @param width The width of the target image, in CSS pixels.
    /// @param height The height of the target image, in CSS pixels.
    /// @return A new Canvas instance initialized with the image data.
    Content.loadCanvas = function (filename, archive, width, height)
    {
        var canvas     = document.createElement('canvas');
        canvas.width   = width;
        canvas.height  = height;
        var context    = canvas.getContext('2d');
        var imageData  = context.createImageData(width, height);
        var entry      = archive.getEntryByName(filename);
        if (entry)
        {
            imageData.data.set(archive.dataAsUint8ClampedArray(entry));
            context.putImageData(imageData, 0, 0);
        }
        return canvas;
    };

    /// Constructor function for the ContentLoader type, which maintains global
    /// state for outstanding content requests and manages background
    /// downloading and foreground parsing of resource packages.
    var ContentLoader = function ()
    {
        if (!(this instanceof ContentLoader))
        {
            return new ContentLoader();
        }
        this.applicationName = '';       // string application name
        this.platformName    = '';       // string runtime platform name
        this.version         = 'latest'; // version to load from app manifest
        this.server          = null;     // content server to manage downloads
        this.groups          = {};       // map group name to package array
        this.versionData     = {};       // packages for platform and version
        this.manifest        = {};       // application manifest
        this.packages        = [];       // package state objects
        this.unpackQueue     = [];       // packages to be unpacked
        return this;
    };
    Emitter.mixin(ContentLoader);

    /// Connects the loader to the content server.
    /// @param background Specify true to run the server on a background
    /// Web Worker thread instead of the main UI thread.
    /// @return A reference to the ContentLoader.
    ContentLoader.prototype.connect = function (background)
    {
        if (background) this.server = new WorkerServer();
        else            this.server = new LocalServer();
        this.server.on('error',     this.handleServerError.bind(this));
        this.server.on('ready',     this.handleServerReady.bind(this));
        this.server.on('progress',  this.handleServerProgress.bind(this));
        this.server.on('resource',  this.handleServerResource.bind(this));
        this.server.startup();
        return this;
    };

    /// Disconnects from the content server. Any pending requests are canceled.
    /// @return A reference to the ContentLoader.
    ContentLoader.prototype.disconnect = function ()
    {
        if (this.server)
        {
            this.server.removeAllListeners();
            this.server.shutdown();
            this.server = null;
        }
        return this;
    };

    /// Requests that a named application cache be opened or created. Caches
    /// are used for caching resources on the client.
    /// @param cacheName A string specifying the name of the application cache.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.openCache = function (cacheName)
    {
        this.applicationName      = this.applicationName || cacheName;
        this.server.createDataStore(this.applicationName);
        return this;
    };

    /// Requests that a named application cache have its current contents
    /// deleted. After deletiion, resources will be requested from the server.
    /// @param cacheName A string specifying the name of the application cache.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.deleteCache = function (cacheName)
    {
        cacheName = cacheName || this.applicationName;
        this.server.deleteDataStore(cacheName);
        return this;
    };

    /// Adds a URL to the list of servers used for downloading application
    /// resources, allowing multiple resources to be downloaded in parallel.
    /// @param url The URL of the content server to add. If the origin is not
    /// the same as that of the requestor, the server must support CORS.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.addServer = function (url)
    {
        this.server.addContentServer(url);
        return this;
    };

    /// Removes a URL from the list of servers used for downloading application
    /// resources. Pending requests against this server will not be cancelled.
    /// @param url The URL of the content server to remove.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.removeServer = function (url)
    {
        this.server.removeContentServer(url);
        return this;
    };

    /// Requests (or re-requests) the application manifest from the server. The
    /// manifest is always downloaded and never retrieved from cache, unless
    /// the user is disconnected from the network.
    /// @param isOffline A boolean value where true indicates that the client
    /// is disconnected from the network.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.loadApplicationManifest = function (isOffline)
    {
        // when offline, always retrieve the manifest from cache.
        // when online, always download the latest manifest version.
        this.server.requestResource({
            requestId    :'manifest',
            cacheName    : this.applicationName,
            resourceName : this.applicationName + '.manifest',
            responseType :'json',
            returnCached : isOffline
        });
        return this;
    };

    /// Submits a load request for a resource package.
    /// @param name The friendly name of the resource package to load.
    /// @param contentSet The ContentSet instance into which the package
    /// resources should be loaded.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.loadPackage = function (name, contentSet)
    {
        return this.loadPackageGroup(name, contentSet, [name]);
    };

    /// Submits load requests for a logical grouping of resource packages.
    /// @param groupName The friendly name of the resource package group.
    /// @param contentSet The ContentSet instance into which the resources
    /// should be loaded.
    /// @param packageNames An array of string friendly names of resource
    /// packages in the group.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.loadPackageGroup = function (groupName, contentSet, packageNames)
    {
        var downloadQueue = [];
        for (var i = 0, n = packageNames.length; i < n; ++i)
        {
            var bundle    = this.findPackage(packageNames[i]);
            if (bundle  === undefined)
                continue;

            // initialize the data associated with the package record.
            // the package record wil be updated further during downloading.
            bundle.progress    = 0;
            bundle.manifest    = null;
            bundle.archive     = null;
            bundle.archiveData = null;
            bundle.groupName   = groupName;
            bundle.contentSet  = contentSet;
            bundle.unpackIndex = 0;
            bundle.unpackState = UnpackState.PARSE_ARCHIVE;
            downloadQueue.push(packageNames[i]);

            // request that the package resource be downloaded from the
            // content server. the runtime will handle queueing for us.
            this.server.requestResource({
                requestId      : packageNames[i],
                cacheName      : this.applicationName,
                resourceName   : bundle.filename,
                responseType   : 'arraybuffer',
                returnCached   : true
            });
        }
        if (downloadQueue.length > 0)
            this.groups[groupName] = downloadQueue;
        return this;
    };

    /// Finds the record representing a resource package.
    /// @param friendlyName A String specifying the friendly name of the
    /// resource package (ie. not the hash.package name.)
    /// @return An object storing the data associated with a resource package:
    /// obj.friendlyName The friendly name of the resource package.
    /// obj.filename The Hash.package format name of the resource package.
    /// obj.manifest An object initialized with the contents of the package
    /// manifest, and specifying the metadata associated with the package
    /// resources. This will be null if the package has not finished loading.
    /// obj.progress A Number specifying the download progress of the resource
    /// package, as a percentage in [0, 100].
    /// obj.contentSet The ContentSet into which the package resources will
    /// be loaded. This will be null unless the package has been loaded, or a
    /// load request is pending.
    /// If the specified name cannot be found, the function returns undefined.
    ContentLoader.prototype.findPackage = function (friendlyName)
    {
        for (var  i = 0, n = this.packages.length; i < n; ++i)
        {
            var pkg = this.packages[i];
            if (pkg.friendlyName === friendlyName)
                return pkg;
        }
    };

    /// Determines whether all resources within a particular resource group
    /// have been fully loaded.
    /// @param groupName The name of the resource group to check. If the
    /// ContentLoader.loadPackage() method was used, the group name is the
    /// friendly name of the resource package.
    /// @return true if all resources in the group have been fully loaded.
    ContentLoader.prototype.hasFullyLoaded = function (groupName)
    {
        var packageList = this.groups[groupName];
        if (packageList)
        {
            for (var i  = 0, n = packageList.length; i < n; ++i)
            {
                if (packageList[i].unpackState !== UnpackState.COMPLETE)
                    return false;
            }
            return true;
        }
        return false;
    };

    /// Executes a single update tick on the main UI thread where downloaded
    /// resource packages are unpacked and transformed into runtime resources.
    /// @param maxTime The maximum amount of time the update tick should take,
    /// specified in milliseconds. If there are no pending resources to be
    /// unpacked and loaded, the function returns immediately.
    /// @param context Application-defined context data to be passed to any
    /// resource loaders.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.unpackResources = function (maxTime, context)
    {
        var   unpackQueue = this.unpackQueue;
        var     startTime = Date.now();
        var     currTime  = startTime;
        while ((currTime  - startTime) < maxTime)
        {
            if (unpackQueue.length === 0)
                return this;

            var    bundle = unpackQueue[0];
            switch(bundle.unpackState)
            {
                case UnpackState.PARSE_ARCHIVE:
                    this.usParseArchive(bundle, context);
                    break;
                case UnpackState.LOAD_RESOURCES:
                    this.usLoadResources(bundle, context);
                    break;
                case UnpackState.COMPLETE:
                    break;
                case UnpackState.ERROR:
                    break;
            }
            currTime = Date.now();
        }
        return this;
    };

    /// Parses a loaded resource package archive and extracts and parses the
    /// package manifest. This is an internal method that updates the current
    /// unpack state.
    /// @param bundle The record representing the resource package state.
    /// @param context Application-defined context data to be passed to any
    /// resource loaders.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.usParseArchive = function (bundle, context)
    {
        var filename       ='package.manifest';
        var tarData        = bundle.archiveData;
        var types          = [TarEntry.FILE];
        bundle.archive     = new TarArchive();
        bundle.archive.parse(types, tarData);
        bundle.manifest    = Content.loadObject(filename, bundle.archive);
        bundle.unpackIndex = 0;
        bundle.unpackState = UnpackState.LOAD_RESOURCES;
        return this;
    };

    /// Loads the next resource from a resource package. This is an internal
    /// method that may update the current unpack state.
    /// @param bundle The record representing the resource package state.
    /// @param context Application-defined context data to be passed to any
    /// resource loaders.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.usLoadResources = function (bundle, context)
    {
        var resources = bundle.manifest.resources;
        var manifest  = bundle.manifest;
        var archive   = bundle.archive;
        var index     = bundle.unpackIndex;
        var count     = resources.length;
        var metadata  = resources[index];
        var resType   = metadata.type;
        var content   = new Content();
        try
        {
            this.emit(resType, {
                loader       : this,
                archive      : archive,
                context      : context,
                metadata     : metadata,
                groupName    : bundle.groupName,
                contentSet   : bundle.contentSet
            });
            bundle.unpackIndex++;
        }
        catch (error)
        {
            this.emit('group:error', {
                loader      : this,
                archive     : archive,
                context     : context,
                metadata    : bundle.metadata,
                groupName   : bundle.groupName,
                contentSet  : bundle.contentSet,
                packageName : bundle.friendlyName
            });
            this.unpackQueue.shift();
            bundle.unpackState = UnpackState.ERROR;
        }
        if (bundle.unpackIndex === count)
        {
            if (this.hasFullyLoaded(bundle.groupName))
            {
                this.emit('group:ready', {
                    loader      : this,
                    context     : context,
                    metadata    : bundle.metadata,
                    groupName   : bundle.groupName,
                    contentSet  : bundle.contentSet,
                    packageName : bundle.friendlyName
                });
            }
            this.unpackQueue.shift();
            bundle.unpackState = UnpackState.COMPLETE;
        }
        return this;
    };

    /// Parses data for the application manifest.
    /// @param data A string specifying the JSON-encoded application manifest.
    /// @return A reference to the ContentLoader instance.
    ContentLoader.prototype.processApplicationManifest = function (data)
    {
        var platform       = this.platformName;
        var manifest       = JSON.parse(data);
        var version        = manifest[this.version];
        var bundles        = version.packages[platform];
        var count          = bundles.length;
        var packages       = new Array(count);
        for (var i = 0;  i < count; ++i)
        {
            packages[i]    = {
                friendlyName : bundles[i].name,
                filename     : bundles[i].file,
                progress     : 0,
                archive      : null,
                manifest     : null,
                contentSet   : null,
                groupName    : '',
                unpackIndex  : 0,
                unpackState  : UnpackState.PARSE_ARCHIVE
            };
        }
        this.manifest    = manifest;
        this.packages    = packages;
        this.versionData = version;
        return this;
    };

    /// Handles an error event generated by the server.
    /// @param data An object specifying data associated with the event.
    /// @param data.requestId An optional value containing the client
    /// identifier associated with the request. This field may be undefined if
    /// the error is not associated with any request.
    /// @param data.error A string describing the error.
    ContentLoader.prototype.handleServerError = function (data)
    {
        this.emit('download:error', {
            loader         : this,
            resourceName   : data.requestId,
            error          : data.error
        });
    };

    /// Handles the cache ready event generated by the server. Once this event
    /// is emitted, resources can be loaded and cached.
    /// @param data An object specifying the data associated with the event.
    /// @param data.name The name of the cache which is now in the ready state.
    ContentLoader.prototype.handleServerReady = function (data)
    {
        if (data.name === this.applicationName)
        {
            // technically the client can request that additional caches be
            // opened; we only want to load the application manifest when the
            // application cache is ready.
            this.loadApplicationManifest(navigator.onLine);
        }
    };

    /// Handles the resource progress event generated by the server. Progress
    /// events may occur multiple times for a single resource.
    /// @param data An object specifying the data associated with the event.
    /// @param data.requestId The client identifier associated with the request.
    /// @param data.progress A number in [0, 100] indicating the percentage of
    /// completion for the resource request.
    ContentLoader.prototype.handleServerProgress = function (data)
    {
        if (data.requestId !== 'manifest')
        {
            var bundle   = this.findPackage(data.requestId);
            if (bundle !== undefined)
            {
                bundle.progress = data.progress;
                this.emit('download:progress', this, bundle);
            }
        }
    };

    /// Handles the resource data event generated by the server when a resource
    /// request has completed successfully and the data is available.
    /// @param data An object specifying the data associated with the event.
    /// @param data.requestId The client identifier associated with the request.
    /// @param data.resourceUrl The URL from which the resource was or would
    /// have been downloaded.
    /// @param data.resourceName The relative path and filename of the resource.
    /// @param data.resourceData The data associated with the resource. The
    /// type depends on what was specified as the desired return type.
    /// @param data.resourceType A string specifying the desired interpretation
    /// of the data returned by the server. May be one of 'blob', 'json',
    /// 'text', 'document' or 'arraybuffer'.
    ContentLoader.prototype.handleServerResource = function (data)
    {
        if (data.requestId !== 'manifest')
        {
            // this is a resource package. add it to the unpack queue.
            var bundle   = this.findPackage(data.requestId);
            if (bundle !== undefined)
            {
                bundle.archiveData  = data.resourceData;
                this.unpackQueue.push(bundle);
            }
        }
        else this.processApplicationManifest(data.resourceData);
    };

    /// Creates and initializes a new ContentLoader instance.
    /// @param args An object specifying initialization data.
    /// @param args.applicationName A string specifying the application name.
    /// This value is used to resolve the application manifest file.
    /// @param args.platformName A string specifying the name of the current
    /// runtime platform. Defaults to an empty string.
    /// @param args.version A string specifying the version of application
    /// content to load. Defaults to the string 'latest'.
    /// @param args.background A boolean value indicating whether resource
    /// packages should be downloaded on a background thread. Defaults to true.
    /// @param args.servers An array of strings specifying the set of content
    /// servers from which resource packages will be downloaded. Defaults to an
    /// empty array; content will be downloaded from the originating domain.
    /// @return A reference to a new ContentLoader instance.
    function createContentLoader(args)
    {
        args                   = args || {};
        args.applicationName   = defaultValue(args.applicationName, 'default');
        args.platformName      = defaultValue(args.platformName,    '');
        args.version           = defaultValue(args.version,         'latest');
        args.background        = defaultValue(args.background,       true);
        args.servers           = defaultValue(args.servers,          []);
        var loader             = new ContentLoader();
        loader.applicationName = args.applicationName;
        loader.platformName    = args.platformName;
        loader.version         = args.version;
        loader.connect(args.background);
        loader.openCache(args.applicationName);
        for (var i = 0,  n = args.servers.length; i < n; ++i)
            loader.addServer(args.servers[i]);

        return loader;
    }

    /// 01. Create ContentLoader 'loader' that runs on the UI thread.
    ///     var loader = ContentJS.createLoader({
    ///         application       : 'foo',
    ///         platform          : 'ps3',
    ///         version           : 'latest',
    ///         background        :  true,
    ///         servers           : [
    ///             'https://foo.bar.com/content',
    ///             'https://foo.car.com/content'
    ///         ]
    ///     });
    /// 02. Subscribe to events. Note that there's no 'progress' event. Instead
    ///     the client will want to poll for the progress of each package.
    ///     loader.on('error', onContentLoaderError(loader, error));
    /// 03. Reload the application manifest with:
    ///     loader.loadApplicationManifest();
    /// 04. [Internal] Once the manifest has finished downloading:
    ///     Reset the progress for all packages to zero.
    ///     Parse the application manifest file.
    ///     Emit a 'manifest:loaded' event.
    /// 05. Once the application manifest has been loaded ('manifest:loaded')
    ///     the client can request that groups of packages be loaded:
    ///     loader.loadPackage(name, set)
    ///     loader.loadPackageGroup(groupName, set, [
    ///         'core',
    ///         'preload',
    ///         'level01'
    ///     ]);
    /// 06. [Internal] Each one of the package names gets queued for download.
    ///     The ContentServer will report 'progress' and 'resource' events.
    ///     The 'progress' event should update the package status and emit a
    ///     'package:progress' event so the client can poll download status.
    ///     The 'resource' event should add the data to a queue and trigger the
    ///     unpack process (if it's not already in-progress.) Unpacking is done
    ///     one package at a time. Should also emit a 'package:download' event
    ///     that specifies the group name and the package name.
    /// 07. Unpacking consists of loading the package.manifest entry within the
    ///     archive file, and then for each resource within the package:
    ///     - Create an internal record to represent it. Load state, etc. can
    ///       be tracked here. Metadata is available as manifest.resources[i]
    ///       with fields name, type, tags[], data[].
    ///     - Pass it off to the registered handler for the resource type,
    ///       probably via an event, like so:
    ///       loader.on('atlas', function (metadata, archive, content, context)
    ///           {
    ///               var resourceName = metadata.name;
    ///               var atlasFile    = Content.fileWithExtension('atlas', metadata);
    ///               var imageFile    = Content.fileWithExtension('image', metadata);
    ///               var atlasData    = Content.loadObject(atlasFile, archive);
    ///               var imageData    = Content.loadPixels(imageFile, archive);
    ///               var video        = Content.loadVideo(...);
    ///               var audio        = Content.loadAudio(...);
    ///               var canvas       = Content.loadCanvas(...);
    ///               content.loaded   = true;
    ///               content.runtime  = {
    ///                   atlas        : atlasData,
    ///                   texture      : context.createTexture(image)
    ///               };
    ///           });
    ///     - Emit a 'resource:loaded' event.
    ///     - Decrement the number of pending resources.
    /// 08. When all packages in a group have been unpacked, the ContentSet
    ///     should emit a 'complete' event to indicate that it is ready for use.
    ///     Client code should store resource references as handles
    /// 09. All of this should work in a time-slice fashion, where the
    ///     loader.update() function is called once per-frame and takes up
    ///     approximately the requested amount of time, or less.
    /// 10. SEE http://www.html5rocks.com/en/tutorials/webgl/typed_arrays/

    /// Specify the data and functions exported from the module.
    exports.ClientCommand = ClientCommand;
    exports.ServerCommand = ServerCommand;
    exports.ContentServer = ContentServer;
    exports.createLoader  = createContentLoader;
    exports.scriptPath    = '';
    return exports;
}(ContentJS || {}));
