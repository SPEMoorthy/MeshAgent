/*
Copyright 2020 Intel Corporation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


// action:
//      msg
//          type:
//               console
//               tunnel
//               messagebox
//               ps
//               pskill
//               services
//               serviceStop
//               serviceStart
//               serviceRestart
//               deskBackground
//               openUrl
//               getclip
//               setclip
//               userSessions
//      acmactivate
//      wakeonlan
//      runcommands
//      toast
//      amtPolicy
//      sysinfo

Object.defineProperty(Array.prototype, 'getParameterEx',
    {
        value: function (name, defaultValue)
        {
            var i, ret;
            for (i = 0; i < this.length; ++i)
            {
                if (this[i].startsWith(name + '='))
                {
                    ret = this[i].substring(name.length + 1);
                    if (ret.startsWith('"')) { ret = ret.substring(1, ret.length - 1); }
                    return (ret);
                }
            }
            return (defaultValue);
        }
    });
Object.defineProperty(Array.prototype, 'getParameter',
    {
        value: function (name, defaultValue)
        {
            return (this.getParameterEx('--' + name, defaultValue));
        }
    });
Object.defineProperty(Array.prototype, 'getParameterIndex',
    {
        value: function (name)
        {
            var i;
            for (i = 0; i < this.length; ++i)
            {
                if (this[i].startsWith('--' + name + '='))
                {
                    return (i);
                }
            }
            return (-1);
        }
    });


var promise = require('promise');
var localmode = true;
var debugmode = false;

function agentConnect(test, ipcPath)
{
    if (global.agentipc_next)
    {
        global.agentipc = global.agentipc_next;
        global.agentipc.count = 0;
        global.agentipc_next = null;
    }
    else
    {
        if (global.agentipc == null)
        {
            global.agentipc = new promise(function (r, j) { this._res = r; this._rej = j; });
            global.agentipc.count = 0;
        }
    }
    global.client = require('net').createConnection({ path: ipcPath });
    global.client.test = test;
    global.client.on('error', function ()
    {
        if (global.agentipc.count++ > 100)
        {
            global.agentipc._rej('      -> Connection Timeout...');
        }
        else
        {
            global._rt = setTimeout(function () { agentConnect(test, ipcPath); }, 100);
        }
    });
    global.client.on('end', function ()
    {
        console.log('      -> Connection error, reconnecting...');
        this.removeAllListeners('data');

        global._timeout = setTimeout(function (a, b) { agentConnect(a, b); }, 100, test, ipcPath);
    });
    global.client.on('data', function (chunk)
    {
        var len;
        if (chunk.length < 4) { this.unshift(chunk); return; }
        if ((len = chunk.readUInt32LE(0)) > chunk.length)
        {
            if (debugmode) { console.log('RECV: ' + chunk.length + ' bytes but expected ' + len + ' bytes'); }
            this.unshift(chunk); return;
        }

        var data = chunk.slice(4, len);
        var payload = null;
        try
        {
            payload = JSON.parse(data.toString());
        }
        catch (e)
        {
            if (debugmode) { console.log('JSON ERROR on emit: ' + data.toString()); }
            return;
        }
        if (debugmode) { console.log('\n' + 'EMIT: ' + data.toString()); }
        if (payload.cmd == 'server')
        {
            this.test.emit('command', payload.value);
        }
        else
        {
            this.test.emit('command', payload);
        }
        if (len < chunk.length)
        {
            if (debugmode) { console.log('UNSHIFT', len, chunk.length); }
            this.unshift(chunk.slice(len));
        }

    });
    global.client.on('connect', function ()
    {
        // Register on the IPC for responses
        try
        {
            var cmd = "_sendConsoleText = sendConsoleText; sendConsoleText = function(msg,id){ for(i in obj.DAIPC._daipc) { obj.DAIPC._daipc[i]._send({cmd: 'console', value: msg});}};";
            cmd += "require('MeshAgent')._SendCommand=require('MeshAgent').SendCommand;require('MeshAgent').SendCommand = function(j){ for(i in obj.DAIPC._daipc) { obj.DAIPC._daipc[i]._send({cmd: 'server', value: j});} };"

            var reg = { cmd: 'console', value: 'eval "' + cmd + '"' };

            if (debugmode)
            {
                console.log(JSON.stringify(reg, null, 1));
            }
            var ocmd = Buffer.from(JSON.stringify(reg));
            var buf = Buffer.alloc(4 + ocmd.length);
            buf.writeUInt32LE(ocmd.length + 4, 0);
            ocmd.copy(buf, 4);
            this.write(buf);

            global._tt = setTimeout(function () { global.agentipc._res(); }, 2000);
        }
        catch (f)
        {
            console.log(f);
        }
    });
}

function start()
{
    var isservice = false;
    var servicename = process.argv.getParameter('serviceName');
    var ipcPath = null;
    var svc = null;
    debugmode = process.argv.getParameter('debugMode', false);

    if (servicename != null)
    {
        try
        {
            var svc = require('service-manager').manager.getService(servicename);
            if (!svc.isRunning())
            {
                console.log('      -> Agent: ' + servicename + ' is not running');
                process._exit();
            }

        }
        catch (e)
        {
            console.log('      -> Agent: ' + servicename + ' not found');
            process._exit();
        }


        if (process.platform == 'win32')
        {
            // Find the NodeID from the registry
            var reg = require('win-registry');
            try
            {
                var val = reg.QueryKey(reg.HKEY.LocalMachine, 'Software\\Open Source\\' + servicename, 'NodeId');
                val = Buffer.from(val.split('@').join('+').split('$').join('/'), 'base64').toString('hex').toUpperCase();
                ipcPath = '\\\\.\\pipe\\' + val + '-DAIPC';
            }
            catch (e)
            {
                console.log('      -> Count not determine NodeID for Agent: ' + servicename);
                process._exit();
            }
        }
        else
        {
            ipcPath = svc.appWorkingDirectory() + 'DAIPC';
        }
    }

    if (debugmode)
    {
        console.log('\n' + 'ipcPath = ' + ipcPath + '\n');
    }

    if (ipcPath != null)
    {
        localmode = false;
        console.log('   -> Connecting to agent...');
        agentConnect(this, ipcPath);

        try
        {
            promise.wait(global.agentipc);
            console.log('      -> Connected........................[OK]');
        }
        catch(e)
        {
            console.log('      -> ERROR........................[FAILED]');
            process._exit();
        }

        this.toAgent = function remote_toAgent(inner)
        {
            inner.sessionid = 'pipe';
            var icmd = "Buffer.from('" + Buffer.from(JSON.stringify(inner)).toString('base64') + "','base64').toString()";
            var ocmd = { cmd: 'console', value: 'eval "require(\'MeshAgent\').emit(\'Command\', JSON.parse(' + icmd + '));"'};
            ocmd = Buffer.from(JSON.stringify(ocmd));

            if (debugmode) { console.log('\n' + 'To AGENT => ' + JSON.stringify(ocmd) + '\n'); }

            var buf = Buffer.alloc(4 + ocmd.length);
            buf.writeUInt32LE(ocmd.length + 4, 0);
            ocmd.copy(buf, 4);
            global.client.write(buf);
        };

        if (debugmode=='2') { console.log('\nDEBUG MODE\n'); return; }
    }

    console.log('Starting Self Test...');

    if (process.argv.getParameter('dumpOnly', false))
    {
        var iterations = process.argv.getParameter('cycleCount', 20);
        console.log('Core Dump Test Mode, ' + iterations + ' cycles');

        DumpOnlyTest(iterations)
            .then(function () { return (completed()); })
            .then(function ()
            {
                console.log('End of Self Test');
                process._exit();
            })
            .catch(function (v)
            {
                console.log(v);
                process._exit();
            });
    }
    else
    {
        coreInfo()
            .then(function () { return (testLMS()); })
            .then(function () { return (testConsoleHelp()); })
            .then(function () { return (testCPUInfo()); })
            .then(function () { return (testTunnel()); })
            .then(function () { return (testTerminal()); })
            .then(function () { return (testKVM()); })
            .then(function () { return (testFileDownload()); })
            .then(function () { return (testCoreDump()); })
            .then(function () { return (testServiceRestart()); })
            .then(function () { return (completed()); })
            .then(function ()
            {
                console.log('End of Self Test');
                process._exit();
            })
            .catch(function (v)
            {
                console.log(v);
                process._exit();
            });
    }
}

function DumpOnlyTest_cycle(pid, cyclecount, p, self)
{
    if(cyclecount==0) { p._res(); return; }

    console.log('   => Starting Cycle: ' + cyclecount + ' Current PID = ' + pid);

    var nextp = new promise(function (r, j) { this._res = r; this._rej = j; });
    global.agentipc_next = nextp

    self.consoleCommand("eval require('MeshAgent').restartCore();").catch(function () { });
    try
    {
        promise.wait(nextp);
    }
    catch(e)
    {
        p._rej(e);
        return;
    }

    try
    {
        var newpid = promise.wait(self.agentQueryValue('process.pid'));
        if (newpid == pid)
        {
            console.log('      => Mesh Core successfully restarted without crashing');
            var t = getRandom(0, 20000);
            console.log('      => Waiting ' + t + ' milliseconds before starting next cycle');
            global._t = setTimeout(function (_pid, _cyclecount, _p, _self)
            {
                DumpOnlyTest_cycle(_pid, _cyclecount, _p, _self);
            }, t, pid, cyclecount-1, p, self);
        }
        else
        {
            p._rej('      => Mesh Core restart resulted in crash. PID = ' + newpid);
        }
        return;
    }
    catch(e)
    {
        p._rej(e);
        return;
    }
}

function DumpOnlyTest(cyclecount)
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    if (localmode)
    {
        ret._rej('   => Background Agent connection required...');
        return (ret);
    }

    var p = this.agentQueryValue("process.pid");
    p.self = this;
    p.then(function (pid)
    {
        DumpOnlyTest_cycle(pid, cyclecount, ret, this.self);
    }).catch(function (v)
    {
        ret._rej(v);
    });

    return (ret);
}

function completed()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret._res();

    if (!localmode)
    {
        // We're restarting the core, to undo the changes that were made to the core, to run the self-test.
        this.consoleCommand("eval require('MeshAgent').restartCore();");
    }
    return (ret);
}

function getFDSnapshot()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret.tester = this;
    ret.tester.consoletext = '';
    ret.consoleTest = this.consoleCommand('fdsnapshot');
    ret.consoleTest.parent = ret;
    ret.consoleTest.then(function (J)
    {
        console.log('   => FDSNAPSHOT');
        console.log(this.tester.consoletext);
        this.parent._res();
    }).catch(function (e)
    {
        this.parent._rej('   => FDSNAPSHOT..........................[FAILED]');
    });
    return (ret);
}

function testLMS()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret.tester = this;
    ret._test = function ()
    {
        // AMT is supported, so we need to test to see if LMS is responding
        this.req = require('http').request(
        {
            protocol: 'http:',
            host: '127.0.0.1',
            port: 16992,
            method: 'GET',
            path: '/'
        });
        this.req.on('response', function (imsg)
        {
            if (this.tester.microlms)
            {
                console.log('         -> Testing MicroLMS..............[OK]');
            }
            else
            {
                console.log('         -> Testing External LMS..........[OK]');
            }
            this.p._res();
        })
        this.req.on('error', function (err)
        {
            if (this.tester.microlms)
            {
                this.p._rej('         -> Testing MicroLMS..............[FAILED]');
            }
            else
            {
                this.p._rej('         -> Testing External LMS..........[FAILED]');
            }
        });
        this.req.tester = this.tester;
        this.req.p = this;
        this.req.end();
    };


    if (!this.amtsupport)
    {
        console.log('         -> Testing LMS...................[N/A]');
        ret._res();
    }
    else
    {
        if (this.microlms)
        {
            this.on('command', function _lmsinfoHandler(v)
            {
                if (v.action == 'lmsinfo')
                {
                    if (v.value.ports.includes('16992'))
                    {
                        this.removeListener('command', _lmsinfoHandler);
                        console.log('         -> Micro LMS bound to 16992......[OK]');
                        ret._test();
                    }
                }
            });
        }
        else
        {
            ret._test();
        }
    }
    return (ret);
}

function coreInfo()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    console.log('   => Waiting for Agent Info');

    ret.tester = this;
    ret.handler = function handler(J)
    {
        if (debugmode) { console.log(JSON.stringify(J)); }
        switch(J.action)
        {
            case 'netinfo':
            case 'sessions':
                ret._sessions = true;
                break;
            case 'coreinfo':
                if (!handler.coreinfo)
                {
                    handler.coreinfo = true;
                    console.log('      -> Core Info received..............[OK]');
                    console.log('');
                    console.log('         ' + J.osdesc);
                    console.log('         ' + J.value);
                    console.log('');
                }
                if (J.intelamt && J.intelamt.microlms == 'CONNECTED')
                {
                    if (!handler.tester.microlms)
                    {
                        handler.tester.microlms = true;
                        console.log('         -> Micro LMS.....................[CONNECTED]');

                        this.removeListener('command', handler);
                        handler.promise._res();
                    }
                }
                if (process.argv.includes('--showCoreInfo="1"'))
                {
                    console.log('\n' + JSON.stringify(J) + '\n');
                }

                break;
            case 'smbios':
                if (!handler.smbios)
                {
                    handler.smbios = true;
                    console.log('      -> SMBIOS Info received.............[OK]');
                    var tables = null;
                    try
                    {
                        tables = require('smbios').parse(J.value);
                        handler.tester.amtsupport = tables.amtInfo && tables.amtInfo.AMT;
                        console.log('         -> AMT Support...................[' + ((tables.amtInfo && tables.amtInfo.AMT == true) ? 'YES' : 'NO') + ']');
                    }
                    catch (e)
                    {
                        clearTimeout(handler.timeout);
                        console.log(e);
                        handler.promise._rej('         -> (Parse Error).................[FAILED]');
                        return;
                    }
                    if (!handler.tester.amtsupport)
                    {
                        clearTimeout(handler.timeout);
                        handler.promise._res();
                    }
                }
                if (process.argv.includes('--smbios="1"'))
                {
                    console.log(JSON.stringify(tables));
                }

                break;
        }
    };
    ret.handler.tester = ret.tester;
    ret.handler.promise = ret;
    ret.handler.coreinfo = false;
    ret.handler.smbios = false;
    ret.tester.amtsupport = false;
    ret.tester.microlms = false;
    ret.tester.on('command', ret.handler);

    ret.handler.timeout = setTimeout(function (r)
    {
        if(!r.handler.coreinfo)
        {
            if (r._sessions)
            {
                console.log('      -> Core Info received...............[OK]')
                r._res();
                return;
            }
            // Core Info was never recevied
            r._rej('      -> Core Info received...............[FAILED]')
        }
        else if(r.handler.amt)
        {
            // AMT support, so check Micro LMS
            if(r.handler.microlms)
            {
                r._res();
            }
            else
            {
                // No MicroLMS, so let's check to make sure there is an LMS service running
                console.log('         -> Micro LMS.....................[NO]');
            }
        }
        else
        {
            // No AMT Support
            r._res();
        }
    }, 10000, ret);

    if (localmode)
    {
        require('MeshAgent').emit('Connected', 3);
    }
    else
    {
        ret._info = this.consoleCommand("eval \"require('MeshAgent').emit('Connected', 3);\"");
    }

    return (ret);
}

function testServiceRestart()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });

    if (localmode)
    {
        ret._res();
        return (ret);
    }
    console.log('   => Service Restart Test');
    ret.self = this;
    //ret._part1 = this.consoleCommand("eval \"var _A=setTimeout(function(){sendConsoleText(require('MeshAgent').serviceName);},1000);\"");
    ret._part1 = this.agentQueryValue("require('MeshAgent').serviceName");
    ret._part1.then(function (c)
    {
        console.log('      => Service Name = ' + c);
        ret._servicename = c;

        var nextp = new promise(function (r, j) { this._res = r; this._rej = j; });
        global.agentipc_next = nextp

        console.log('      -> Restarting Service...');
        ret.self.consoleCommand("service restart").catch(function (x)
        {
            //ret._rej('         -> Restarted.....................[FAILED]');
        });

        try
        {
            promise.wait(nextp);
            console.log('         -> Restarted.....................[OK]');
            ret._res();
        }
        catch(f)
        {
            console.log(f);
            ret._rej('         -> Restarted.....................[FAILED]');
        }
    });

    return (ret);
}

function testCoreDump()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });

    if (localmode)
    {
        ret._res();
        return (ret);
    }
    console.log('   => Mesh Core Dump Test');
    ret.self = this;
    ret.consoleTest = this.consoleCommand('eval process.pid');
    ret.consoleTest.ret = ret;
    ret.consoleTest.self = this;
    ret.consoleTest.then(function coreDumpTest_1(c)
    {
        var pid = c;
        console.log('      -> Agent PID = ' + c);

        if (process.platform == 'linux' || process.platform == 'freebsd')
        {
            var p = ret.self.agentQueryValue("require('monitor-info').kvm_x11_support");
            if (promise.wait(p).toString() != 'true')
            {
                // No KVM Support, so just do a plain dump test
                var nextp = new promise(function (r, j) { this._res = r; this._rej = j; });
                global.agentipc_next = nextp
                console.log('      -> Initiating plain dump test');
                ret.self.consoleCommand("eval require('MeshAgent').restartCore();");
                try
                {
                    promise.wait(nextp);
                    ret.self.agentQueryValue('process.pid').then(function (cc)
                    {
                        if (cc == pid)
                        {
                            console.log('      -> Core Restarted without crashing..[OK]');
                            ret._res();
                        }
                        else
                        {
                            ret._rej('      -> Core Restart resulted in crash...[FAILED]');
                        }
                    });
                }
                catch (z)
                {
                    ret._rej('      -> ERROR', z);
                }
                return;
            }
        }

        console.log('      -> Initiating KVM for dump test');
        ret.tunnel = this.self.createTunnel(0x1FF, 0x00);
        ret.tunnel.then(function (c)
        {
            this.connection = c;
            c.ret = this.ret;
            c.jumbosize = 0;
            c.on('data', function (buf)
            {
                if (typeof (buf) == 'string') { return; }
                var type = buf.readUInt16BE(0);
                var sz = buf.readUInt16BE(2);

                if (type == 3 && sz == buf.length)
                {
                    this.removeAllListeners('data');
                    var nextp = new promise(function (r, j) { this._res = r; this._rej = j; });
                    global.agentipc_next = nextp

                    console.log('      -> KVM initiated, dumping core');
                   ret.self.consoleCommand("eval require('MeshAgent').restartCore();");
                   // ret.self.consoleCommand("eval _debugCrash()");

                    try
                    {
                        promise.wait(nextp);
                        ret.self.agentQueryValue('process.pid').then(function (cc)
                        {
                            if(cc==pid)
                            {
                                console.log('      -> Core Restarted without crashing..[OK]');
                                ret._res();
                            }
                            else
                            {
                                ret._rej('      -> Core Restart resulted in crash...[FAILED]');
                            }
                        });
                    }
                    catch(z)
                    {
                        console.log('      -> ERROR', z);
                    }

                }
            });

            c.write('c');
            c.write('2'); // Request KVM
        });

    });

    return (ret);
}
function testFileDownload()
{
    console.log('   => File Transfer Test');
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret.tester = this;
    ret.tunnel = this.createTunnel(0x1FF, 0x00);
    ret.tunnel.ret = ret;
    ret.tunnel.then(function (c)
    {
        this.connection = c;
        c.ret = this.ret;
        c.ret.testbuffer = require('EncryptionStream').GenerateRandom(65535); // Generate 64k Test Buffer
        c.ret.testbufferCRC = crc32c(c.ret.testbuffer);

        c.on('data', function (buf)
        {
            // JSON Control Packet
            var cmd = JSON.parse(buf.toString());
            switch (cmd.action)
            {
                case 'uploadstart':
                    // Start sending the file in 16k blocks
                    this.uploadBuffer = this.ret.testbuffer.slice(0);
                    this.write(this.uploadBuffer.slice(0, 16384));
                    this.uploadBuffer = this.uploadBuffer.slice(16384);
                    break;
                case 'uploadack':
                    this.write(this.uploadBuffer.slice(0, this.uploadBuffer.length > 16384 ? 16384 : this.uploadBuffer.length));
                    this.uploadBuffer = this.uploadBuffer.slice(this.uploadBuffer.length > 16384 ? 16384 : this.uploadBuffer.length);
                    if (this.uploadBuffer.length == 0)
                    {
                        this.write({ action: 'uploaddone' });
                    }
                    break;
                case 'uploaddone':
                    console.log('      -> File Transfer (Upload)...........[OK]');
                    this.uploadsuccess = true;
                    this.end();
                    break;
            }
        });
        c.on('end', function ()
        {
            if (this.uploadsuccess != true)
            {
                this.ret._rej('      -> File Transfer (Upload)...........[FAILED]');
                return;
            }

            // Start download test, so we can verify the data
            this.ret.download = this.ret.tester.createTunnel(0x1FF, 0x00);
            this.ret.download.ret = this.ret;
            this.ret.download.tester = this.ret.tester;

            this.ret.download.then(
                function (dt)
                {
                    dt.ret = this.ret;
                    dt.crc = 0;
                    dt.on('data', function (b)
                    {
                        if(typeof(b)=='string')
                        {
                            var cmd = JSON.parse(b);
                            if (cmd.action != 'download') { return; }
                            switch(cmd.sub)
                            {
                                case 'start':
                                    this.write({ action: 'download', sub: 'startack', id: 0 });
                                    break;
                            }
                        }
                        else
                        {
                            var fin = (b.readInt32BE(0) & 0x01000001) == 0x01000001;
                            this.crc = crc32c(b.slice(4), this.crc);
                            this.write({ action: 'download', sub: 'ack', id: 0 });
                            if(fin)
                            {
                                if(this.crc == this.ret.testbufferCRC)
                                {
                                    // SUCCESS!

                                    console.log('      -> File Transfer (Download).........[OK]');
                                    this.end();
                                    this.ret._res();
                                }
                                else
                                {
                                    this.end();
                                    this.ret._rej('      -> File Transfer (Download).........[CRC FAILED]');
                                }
                            }
                        }
                    });
                    dt.on('end', function ()
                    {

                    });

                    console.log('      -> Tunnel (Download)................[CONNECTED]');
                    dt.write('c');
                    dt.write('5'); // Request Files
                    dt.write(JSON.stringify({ action: 'download', sub: 'start', path: process.cwd() + 'testFile', id: 0 }));
                })
                .catch(function (dte)
                {
                    this.ret._rej('      -> Tunnel (Download)................[FAILED]');
                });
        });

        console.log('      -> Tunnel (Upload)..................[CONNECTED]');
        c.write('c');
        c.write('5'); // Request Files
        c.write(JSON.stringify({ action: 'upload', name: 'testFile', path: process.cwd(), reqid: '0' }));
    }).catch(function (e)
    {
        this.parent._rej('   => File Transfer Test (Upload) [TUNNEL FAILED] ' + e);
    });

    return (ret);
}

function testCPUInfo()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    if (process.platform == 'freebsd')
    {
        console.log('   => Testing CPU Info....................[N/A]');
        ret._res();
        return (ret);
    }

    ret.consoleTest = this.consoleCommand('cpuinfo');
    ret.consoleTest.parent = ret;
    ret.consoleTest.then(function (J)
    {
        try
        {
            JSON.parse(J.toString());
            console.log('   => Testing CPU Info....................[OK]');
        }
        catch (e)
        {
            ret._rej('   => Testing CPU Info....................[ERROR]');
            return;
        }
        ret._res();
    }).catch(function (e)
    {  
        ret._rej('   => Testing CPU Info....................[FAILED]');
    });
    return (ret);
}

function testKVM()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret.tester = this;

    if (!localmode)
    {
        if(process.platform == 'linux' || process.platform == 'freebsd')
        {
            var p = this.agentQueryValue("require('monitor-info').kvm_x11_support");
            var val = promise.wait(p);
            if (val == false)
            {
                console.log('   => KVM Test............................[X11 NOT DETECTED]');
                ret._res();
                return (ret);
            }
        }
    }

    if (require('MeshAgent').hasKVM != 0)
    {
        if (process.platform == 'linux' || process.platform == 'freebsd')
        {
            if(require('monitor-info').kvm_x11_support == false)
            {
                // KVM Support detected
                console.log('   => KVM Test............................[X11 NOT DETECTED]');
                ret._res();
                return (ret);
            }
        }
    }
    else
    {
        // KVM Support not compiled into agent
        console.log('   => KVM Test............................[NOT SUPPORTED]');
        ret._res();
        return (ret);
    }
    console.log('   => KVM Test');
    ret.tunnel = this.createTunnel(0x1FF, 0xFF);
    ret.tunnel.ret = ret;

    ret.tunnel.then(function (c)
    {
        this.connection = c;
        c.ret = this.ret;
        c.jumbosize = 0;
        c.on('data', function (buf)
        {
            if (typeof (buf) == 'string') { return; }
            var type = buf.readUInt16BE(0);
            var sz = buf.readUInt16BE(2);

            if (type == 27)
            {
                // JUMBO PACKET
                sz = buf.readUInt32BE(4);
                type = buf.readUInt16BE(8);
                console.log('      -> Received JUMBO (' + sz + ' bytes)');              

                if (buf.readUInt16BE(12) != 0)
                {
                    this.ret._rej('      -> JUMBO/RESERVED...................[ERROR]');
                    this.end();
                }
                buf = buf.slice(8);
            }
            
            if(type == 3 && sz == buf.length)
            {
                console.log('      -> Received BITMAP');
                console.log('      -> Result...........................[OK]');
                this.removeAllListeners('data');
                this.end();
                this.ret._res();
            }
        });
        c.on('end', function ()
        {
            this.ret._rej('      -> (Unexpectedly closed)............[FAILED]');
        });

        console.log('      -> Tunnel...........................[CONNECTED]');
        console.log('      -> Triggering User Consent');
        c.write('c');
        c.write('2'); // Request KVM
    }).catch(function (e)
    {
        this.parent._rej('      -> Tunnel...........................[FAILED]');
    });

    return (ret);
}

//
// 1 = root
// 8 = user
// 6 = powershell (root
// 9 = powershell (user)
//
function testTerminal(terminalMode)
{
    console.log('   => Terminal Test');
    if (terminalMode == null) { terminalMode = 1; }
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret.parent = this;
    var consent = 0xFF;

    if (process.platform == 'linux' || process.platform == 'freebsd')
    {
        if (localmode)
        {
            if (!require('monitor-info').kvm_x11_support) { consent = 0x00; }
        }
        else
        {
            var p = this.agentQueryValue("require('monitor-info').kvm_x11_support");
            if (promise.wait(p).toString() != 'true') { consent = 0x00; }
        }
    }

    ret.tunnel = this.createTunnel(0x1FF, consent);
    ret.mode = terminalMode.toString();
    ret.tunnel.parent = ret;
    ret.tunnel.then(function (c)
    {
        this.connection = c;
        c.ret = this.parent;
        c.ret.timeout = setTimeout(function (r)
        {
            r.tunnel.connection.end();
            r._rej('      -> Result...........................[TIMEOUT]');
        }, 7000, c.ret);
        c.tester = this.parent.parent; c.tester.logs = '';
        c.on('data', function _terminalDataHandler(c)
        {
            try
            {
                JSON.parse(c.toString());
            }
            catch(e)
            {
                console.log('      -> Result...........................[OK]');
                this.removeListener('data', _terminalDataHandler);
                if (process.platform == 'win32')
                {
                    this.end('exit\r\n');
                }
                else
                {
                    this.end('exit\n');
                }
                this.ret._res();
                clearTimeout(this.ret.timeout);
            }
        });
        c.on('end', function ()
        {
            this.ret._rej('      -> (Unexpectedly closed)............[FAILED]');
        });

        console.log('      -> Tunnel...........................[CONNECTED]');
        if (consent != 0)
        {
            console.log('      -> Triggering User Consent');
        }
        else
        {
            console.log('      -> Skipping User Consent');
        }
        c.write('c');
        c.write(c.ret.mode);
    }).catch(function (e)
    {
        this.parent._rej('      -> Tunnel...........................[FAILED]');
    });

    return (ret);
}
function testConsoleHelp()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret.consoleTest = this.consoleCommand('help');
    ret.consoleTest.parent = ret;
    ret.consoleTest.then(function (J)
    {
        console.log('   => Testing console command: help.......[OK]');
        this.parent._res();
    }).catch(function (e)
    {
        ret._rej('   => Testing console command: help.......[FAILED]');
    });
    return (ret);
}
function testTunnel()
{
    var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
    ret.tunneltest = this.createTunnel(0, 0);
    ret.tunneltest.parent = ret;

    ret.tunneltest.then(function (c)
    {
        console.log('   => Tunnel Test.........................[OK]');
        c.end();
        this.parent._res();
    }).catch(function (e)
    {   
        ret._rej('   => Tunnel Test.........................[FAILED] ');
    });

    return (ret);
}

function setup()
{
    this._ObjectID = 'meshore-tester';
    require('events').EventEmitter.call(this, true)
        .createEvent('command')
        .createEvent('tunnel');
    this._tunnelServer = require('http').createServer();
    this._tunnelServer.promises = [];
    this._tunnelServer.listen({ port: 9250 });
    this._tunnelServer.on('upgrade', function (imsg, sck, head)
    {
        var p = this.promises.shift();
        clearTimeout(p.timeout);
        p._res(sck.upgradeWebSocket());
    });
    this.testTunnel = testTunnel;
    this.toServer = function toServer(j)
    {
        //mesh.SendCommand({ action: 'msg', type: 'console', value: text, sessionid: sessionid });
        toServer.self.emit('command', j);
    };
    this.toServer.self = this;
    this.toAgent = function(j)
    {
        if (debugmode) { console.log('toAgent() => ', JSON.stringify(j)); }
        require('MeshAgent').emit('Command', j);
    }
    this.createTunnel = function createTunnel(rights, consent)
    {
        var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
        ret.parent = this;
        this._tunnelServer.promises.push(ret);
        ret.timeout = setTimeout(function ()
        {
            ret._rej('timeout');
        }, 2000);
        ret.options = { action: 'msg', type: 'tunnel', rights: rights, consent: consent, username: '(test script)', value: 'ws://127.0.0.1:9250/test' };
        this.toAgent(ret.options);

        return (ret);
    }

    this.agentQueryValue = function agentQueryValue(value)
    {
        var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
        //ret._part1 = this.consoleCommand("eval \"var _A=setTimeout(function(){sendConsoleText(require('MeshAgent').serviceName);},1000);\"");

        var cmd = 'eval "var _A=setTimeout(function(){for(i in obj.DAIPC._daipc){ obj.DAIPC._daipc[i]._send({cmd: \'queryResponse\', value: ' + value + '});}},500);"';
        ret.parent = this;
        ret.handler = function handler(j)
        {
            //console.log('handler', JSON.stringify(j));
            if (j.cmd == 'queryResponse')
            {
                clearTimeout(handler.promise.timeout);
                handler.promise.parent.removeListener('command', handler);
                handler.promise._res(j.value);
            }
        };
        ret.handler.promise = ret;
        ret.timeout = setTimeout(function (r)
        {
            r.parent.removeListener('command', r.handler);
            r._rej('QueryTimeout');
        }, 8000, ret);
        this.on('command', ret.handler);
        this.toAgent({ action: 'msg', type: 'console', rights: 0xFFFFFFFF, value: cmd, sessionid: -1 });
        return (ret);
    };

    this.consoleCommand = function consoleCommand(cmd)
    {
        var ret = new promise(function (res, rej) { this._res = res; this._rej = rej; });
        ret.parent = this;
        ret.tester = this;
        ret.handler = function handler(j)
        {
            if((j.action == 'msg' && j.type == 'console') || j.cmd=='console')
            {
                clearTimeout(handler.promise.timeout);
                handler.promise.tester.removeListener('command', handler);
                handler.promise._res(j.value);
            }
        };
        ret.handler.promise = ret;
        ret.timeout = setTimeout(function (r)
        {
            r.tester.removeListener('command', r.handler);
            r._rej('ConsoleCommandTimeout');
        }, 5000, ret);
        this.on('command', ret.handler);
        this.toAgent({ action: 'msg', type: 'console',rights: 0xFFFFFFFF, value: cmd, sessionid: -1 });
        return (ret);
    };

    this.start = start;

    console.log('   -> Setting up Mesh Agent Self Test.....[OK]');
    require('MeshAgent').SendCommand = this.toServer;
    this.consoletext = '';
    this.logs = '';
    this.on('command', function (j)
    {
        switch(j.action)
        {
            case 'msg':
                if (j.type == 'console') { this.consoletext += j.value; }
                break;
            case 'log':
                this.logs += j.msg;
                break;
        }
    });

    this.start();
}

function getRandom(min, max)
{
    var range = max - min;
    var val = Math.random() * range;
    val += min;
    return (Math.floor(val));
}


module.exports = setup;
