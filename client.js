const request = require('request-promise');
const payloads = require('./payloads.js');
const readline = require('readline');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const qs = require('querystring');
const Channel = require(`@nodeguy/channel`);

let fo = o => o[Object.keys(o)[0]];
let jar = request.jar();

const domain = 'https://repl.it';

class Client {
  constructor(options) {
    this.payload = payloads[options.language];
    this.options = options;
    this.language = this.payload ? this.payload.lang : this.options.language;
    this.read_channel = new Channel();
    this.mode = options.mode || 'runShell';
    this.inputCommand = 'input';
    this.spinner = options.spinner || spinner;
    this.prompt = options.prompt || prompt;
  }
  async auth() {
    let resp = await request({
      url: `${domain}/languages/${this.language}`,
      headers: {
        //'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3396.99 Safari/537.36'
        'User-Agent': 'Mozilla/5.0 (repl.sh)',
      },
      jar: jar,
    });

    let sessionJSON = resp.match(/__NEXT_DATA__ = ([^\n]+)/im);
    let session = JSON.parse(sessionJSON[1]);
    let repl = fo(session.props.pageProps.initialState.repls.data);
    this.slug = repl.title;
    this.replid = repl.id;

    // Warning: this is both rate-limited and will ask for captcha challenge
    // if detects fishiness so it might fail :/
    resp = await request.post({
      url: `${domain}/data/repls/${repl.id}/gen_repl_token`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (repl.sh)',
      },
      jar: jar,
    });

    this.token = JSON.parse(resp);
  }

  send(o) {
    let client = this.client;
    return new Promise(function(res, rej) {
      client.send(JSON.stringify(o), function err(err) {
        if (err) return rej(err);
        else res();
      });
    });
  }

  read() {
    return this.read_channel.shift();
  }

  async launch() {
    let payshell;
    if ( this.payload ) {
      payshell  = this.payload.shell.replace(
          /\$\$TERM\$\$/g,
          process.env.TERM || 'xterm-color',
      );
    }

    let files = [];
    if (this.payload && this.payload.main) {
      files.push({
        name: this.payload.main,
        content: Buffer.from(payshell).toString('base64'),
        encoding: 'base64',
      });
    }

    for (let f of this.options.file) {
      let b = fs.readFileSync(f);
      files.push({
        //name: path.basename(f),
        name: f,
        content: b.toString('base64'),
        encoding: 'base64',
      });
      if (this.options.save) await this.commit(f, b);
    }

    await this.send({
      command: "saneTerm"
    });

    if ( this.mode == "runShell" ) {

      if (this.payload.main) {
        await this.send({ command: "runProject", data: JSON.stringify(files) });
      } else {
        await this.send({ command: "eval", data: payshell });
      }
    } if ( this.mode == "interp" ) {
      this.inputCommand = 'interpInput';
      await this.send({command: "interpInit"});
    } else {  
      this.inputCommand = 'shellInput';
      await this.send({command: "shellInit"});
    }
 
    await new Promise(res => setTimeout(res, 1000));


    await this.send({
      command: "resizeTerm",
      data: JSON.stringify({
        cols: process.stdout.columns,
        rows: process.stdout.rows
      })
    });



    if (this.options.send) {
      await this.send({
        command: this.inputCommand,
        data: this.options.send + "\r"
      });
    }
  }

  async commit(file, contents) {
    let data;
    try {
      data = await request({
        url: `https://repl.it/data/repls/signed_urls/${this.replid}/${qs.escape(
          file,
        )}`,
        jar: jar,
      });
    } catch (e) {
      this.spinner.fail('Couldnt get token to write ' + file);
      console.log(e);
      return;
    }
    let target = JSON.parse(data).urls_by_action;
    await request({
      uri: target.write,
      method: 'PUT',
      body: contents,
    });
    this.spinner.info('Wrote ' + file + ' to GCS');
  }

  async connect() {
    let host = this.options.goval;
    if (!/^wss?:/.test(host)) host = 'wss://' + host;
    let client = new WebSocket(host + '/ws');

    this.client = client;
    this.clean = false;
    this.buffer = [];
    this.readers = [];

    client.on('close', () => {
      if (this.clean) return;
      this.spinner.fail('Socket closed?');
      return exit(1);
    });

    client.on('message', d => {
      this.read_channel.push(JSON.parse(d));
    });

    await new Promise(function(res, rej) {
      client.on('open', e => {
        res(true);
      });
    });

    let read = this.read.bind(this);
    if (this.token) {
      this.prompt('Sending Auth...');
      await this.send({ command: 'auth', data: this.token });
      await read();
      this.prompt('Waiting for ready...');
      await this.send({ command: 'select_language', data: this.language });
      await read();
    }
  }

  async go() {
    //console.log(JSON.stringify(repl, null, '  '));
    let read = this.read.bind(this);
    let send = this.send.bind(this);
    if (this.options.watch) {
      this.watcher = chokidar.watch(this.options.file, {
        awaitWriteFinish: true,
      });
      this.watcher.on('change', file => {
        if (this.options.reset) {
          this.spinner.info(`File ${file} changed, restarting...`);
          send({ command: 'stop' }).then(() => this.launch());
        } else {
          let fj = {
            name: file,
            content: fs.readFileSync(file, 'base64'),
            encoding: 'base64',
          };

          send({
            command: 'write',
            data: JSON.stringify(fj),
          });
        }
      });
    }

    this.attachTTY();
    await this.run();
  }

  attachTTY() {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    let write_buffer = [];

    process.stdin.on('keypress', (str, key) => {
      //console.log(str, key);
      if (key.sequence == '\u001d') {
        exit(0);
      }
      if (key.sequence == '\u001b') {
        this.send({ command: 'interpRun', data: ''});
	return;
      }
      write_buffer.push(key.sequence);
    });

    process.stdout.on('resize', () => {
      this.send({
        command: 'resizeTerm',
        data: JSON.stringify({
          cols: process.stdout.columns,
          rows: process.stdout.rows,
        }),

      });
    });

    let writer = () => {
      if (write_buffer.length > 0) {
        this.send({ command: this.inputCommand, data: write_buffer.join("") });
        write_buffer = [];
      }
      if (!this.clean) setTimeout(writer, 5);
    };
    writer();
  }

  async run() {
    let read = this.read.bind(this);
    while (!this.clean) {
      let d = await read();

      if (d.command == "output" || d.command == "event:shellOutput" || d.command == "event:interpOutput" ) {
        //console.log(d);
        this.spinner.stop();
        process.stdout.write(d.data.replace(/zîº§|/g,'⠕'));
      } else if (d.command == "result" || d.command == "event:interpSleep") {
        if (d.error) {
          if ( d.error == 'unknown command "resizeTerm"' ) continue;
          if ( d.error == 'unknown command "saneTerm"' ) continue;

          this.spinner.fail(d.error);
        } else if (d.data) {
          this.spinner.succeed(d.data);
        }
        if (process.stdin) {
          process.stdin.setRawMode(false);
          process.stdin.end();
        }
        this.disconnect();
        return 0;
      } else if (d.command == 'ready') {
        this.prompt('Got shell, waiting for prompt');
      } else if (d.command == 'event:portOpen') {
        let j = JSON.parse(d.data);
        this.spinner.succeed(
          `Site open at https://${this
            .slug}--five-nine.repl.co (${j.port} -> 80)`,
        );
      } else if (d.command == 'event:packageInstallOutput') {
        if (d.error) {
          this.spinner.fail(d.error);
        } else {
          console.log(d.data);
        }
      } else {
        if (d.error) {
          if (d.error == 'shell exited' ) this.disconnect();
          this.spinner.fail(d.error);
        } else if (['write', 'files'].indexOf(d.command) == -1) {
          this.spinner.info(d.command + ':' + d.data);
        }
      }
    }
  }
  disconnect() {
    this.clean = true;
    this.client.close();
    if (this.watcher) this.watcher.close();
  }
}

module.exports = Client;
