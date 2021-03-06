var _ = require('underscore');
var TelegramBot = require('node-telegram-bot-api');
var moment = require('moment');
var ChatContext = require('./lib/chat-context');
var ChatLog = require('./lib/chat-log.js');
var helpers = require('./lib/telegram/telegram');
var DEBUG = false;

module.exports = function(RED) {

  function TelegramBotNode(n) {
    RED.nodes.createNode(this, n);

    var self = this;
    this.botname = n.botname;
    this.polling = n.polling;
    this.log = n.log;

    this.usernames = [];
    if (n.usernames) {
      this.usernames = _(n.usernames.split(',')).chain()
        .map(function(userId) {
          return userId.match(/^[a-zA-Z0-9_]+?$/) ? userId : null
        })
        .compact()
        .value();
    }

    this.isAuthorized = function (username, userId) {
      if (self.usernames.length > 0) {
        return self.usernames.indexOf(username) != -1 || self.usernames.indexOf(String(userId)) != -1;
      }
      return true;
    };

    // creates the message details object from the original message
    this.getMessageDetails = function getMessageDetails(botMsg) {
      var telegramBot = self.telegramBot;
      return new Promise(function(resolve, reject) {
        if (botMsg.text) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'message',
            content: botMsg.text,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else if (botMsg.photo) {
          telegramBot.getFileLink(botMsg.photo[botMsg.photo.length - 1].file_id)
            .then(function(path) {
              return helpers.downloadFile(path);
            })
            .then(function(buffer) {
              resolve({
                chatId: botMsg.chat.id,
                messageId: botMsg.message_id,
                type: 'photo',
                content: buffer,
                caption: botMsg.caption,
                date: moment.unix(botMsg.date),
                inbound: true
              });
            })
            .catch(function(error) {
              reject(error);
            });
        } else if (botMsg.audio) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'audio',
            content: botMsg.audio.file_id,
            caption: botMsg.caption,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else if (botMsg.document) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'document',
            content: botMsg.document.file_id,
            caption: botMsg.caption,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else if (botMsg.sticker) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'sticker',
            content: botMsg.sticker.file_id,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else if (botMsg.video) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'video',
            content: botMsg.video.file_id,
            caption: botMsg.caption,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else if (botMsg.voice) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'voice',
            content: botMsg.voice.file_id,
            caption: botMsg.caption,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else if (botMsg.location) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'location',
            content: botMsg.location,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else if (botMsg.contact) {
          resolve({
            chatId: botMsg.chat.id,
            messageId: botMsg.message_id,
            type: 'contact',
            content: botMsg.contact,
            date: moment.unix(botMsg.date),
            inbound: true
          });
        } else {
          reject('Unable to detect incoming Telegram message');
        }

      });
    };

    this.handleCallback = function(botMsg) {
      var chatId = botMsg.message.chat.id;
      var alert = false;
      var answer = null;
      if (self.telegramBot.lastInlineButtons[chatId] != null) {
        // find the button with the right value, takes the answer and alert if any
        var button = _(self.telegramBot.lastInlineButtons[chatId]).findWhere({value: botMsg.data});
        if (button != null) {
          answer = button.answer;
          alert = button.alert;
        }
        // do not remove from hash, the user could click again
      }
      // send answer back to client
      self.telegramBot.answerCallbackQuery(botMsg.id, answer, alert)
        .then(function() {
          // send through the message as usual
          botMsg.message.text = botMsg.data;
          self.handleMessage(botMsg.message);
        });
    };

    this.handleMessage = function(botMsg) {

      var telegramBot = self.telegramBot;
      // mark the original message with the platform
      botMsg.transport = 'telegram';

      if (DEBUG) {
        console.log('START:-------');
        console.log(botMsg);
        console.log('END:-------');
      }
      var username = !_.isEmpty(botMsg.from.username) ? botMsg.from.username : null;
      var chatId = botMsg.chat.id;
      var userId = botMsg.from.id;
      var isAuthorized = self.isAuthorized(username, userId);

      var context = self.context(); context.global = context.global || context;
      // get or create chat id,
      if (context.global != null) {
        var chatContext = context.global.get('chat:' + chatId);
        if (chatContext == null) {
          chatContext = ChatContext(chatId);
          context.global.set('chat:' + chatId, chatContext);
        }
      } else {
        self.error('Unable to find context().global in Node-RED ');
      }

      // store some information
      chatContext.set('chatId', chatId);
      chatContext.set('messageId', botMsg.message_id);
      chatContext.set('userId', userId);
      chatContext.set('firstName', botMsg.from.first_name);
      chatContext.set('lastName', botMsg.from.last_name);
      chatContext.set('authorized', isAuthorized);
      chatContext.set('transport', 'telegram');
      chatContext.set('message', botMsg.text);

      // decode the message
      self.getMessageDetails(botMsg)
        .then(function(payload) {
          var chatLog = new ChatLog(chatContext);
          return chatLog.log({
            payload: payload,
            originalMessage: botMsg,
            chat: function() {
              return context.global.get('chat:' + chatId);
            }
          }, self.log)
        })
        .then(function(msg) {

          var currentConversationNode = chatContext.get('currentConversationNode');
          // if a conversation is going on, go straight to the conversation node, otherwise if authorized
          // then first pin, if not second pin
          if (currentConversationNode != null) {
            // void node id
            chatContext.set('currentConversationNode', null);
            // emit message directly the node where the conversation stopped
            RED.events.emit('node:' + currentConversationNode, msg);
          } else {
            telegramBot.emit('relay', msg);
          }
        })
        .catch(function(error) {
          telegramBot.emit('relay', null, error);
        });
    }; // end handleMessage

    var telegramBot = null;
    if (this.credentials) {
      this.token = this.credentials.token;
      if (this.token) {
        this.token = this.token.trim();
        if (!this.telegramBot) {
          telegramBot = new TelegramBot(this.token, {
            polling: {
              timeout: 10,
              interval: !isNaN(parseInt(self.polling, 10)) ? parseInt(self.polling, 10) : 1000
            }
          });
          this.telegramBot = telegramBot;
          this.telegramBot.setMaxListeners(0);
          this.telegramBot.on('message', this.handleMessage);
          this.telegramBot.on('callback_query', this.handleCallback);
        }
      }
    }

    this.on('close', function (done) {
      // stop polling only once
      if (this.telegramBot != null && this.telegramBot._polling) {
        self.telegramBot.off('message', self.handleMessage);
        self.telegramBot.off('callback_query', self.handleCallback);
        self.telegramBot.stopPolling()
          .then(function() {
            self.telegramBot = null;
            done();
          });
      } else {
        done();
      }
    });
  } // end TelegramBotNode

  RED.nodes.registerType('chatbot-telegram-node', TelegramBotNode, {
    credentials: {
      token: {
        type: 'text'
      }
    }
  });

  function TelegramInNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    this.bot = config.bot;

    this.config = RED.nodes.getNode(this.bot);
    if (this.config) {
      this.status({fill: 'red', shape: 'ring', text: 'disconnected'});

      node.telegramBot = this.config.telegramBot;
      if (node.telegramBot) {
        this.status({fill: 'green', shape: 'ring', text: 'connected'});

        /*
        todo implement inline
        node.telegramBot.on('inline_query', function(botMsg) {
          console.log('inline request', botMsg);
        });*/

        node.telegramBot.on('relay', function(message, error) {
          if (error != null) {
            node.error(error);
          } else {
            node.send(message);
          }
        });
      } else {
        node.warn("no bot in config.");
      }
    } else {
      node.warn("no config.");
    }
  }
  RED.nodes.registerType('chatbot-telegram-receive', TelegramInNode);

  function TelegramOutNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    this.bot = config.bot;
    this.track = config.track;

    this.config = RED.nodes.getNode(this.bot);
    if (this.config) {
      this.status({
        fill: 'red',
        shape: 'ring',
        text: 'disconnected'
      });

      node.telegramBot = this.config.telegramBot;
      if (node.telegramBot) {
        this.status({
          fill: 'green',
          shape: 'ring',
          text: 'connected'
        });
      } else {
        node.warn("no bot in config.");
      }
    } else {
      node.warn("no config.");
    }

    // relay message
    var handler = function(msg) {
      node.send(msg);
    };
    RED.events.on('node:' + config.id, handler);

    // cleanup on close
    this.on('close',function() {
      RED.events.removeListener('node:' + config.id, handler);
    });

    this.on('input', function (msg) {

      // check if the message is from telegram
      if (msg.originalMessage != null && msg.originalMessage.transport !== 'telegram') {
        // exit, it's not from telegram
        return;
      }

      if (msg.payload == null) {
        node.warn("msg.payload is empty");
        return;
      }
      if (msg.payload.chatId == null) {
        node.warn("msg.payload.chatId is empty");
        return;
      }
      if (msg.payload.type == null) {
        node.warn("msg.payload.type is empty");
        return;
      }

      var context = node.context(); context.global = context.global || context;
      var buttons = null;
      var track = node.track;
      var chatId = msg.payload.chatId || (originalMessage && originalMessage.chat.id);
      var chatContext = context.global.get('chat:' + chatId);
      var type = msg.payload.type;

      // check if this node has some wirings in the follow up pin, in that case
      // the next message should be redirected here
      if (chatContext != null && track && !_.isEmpty(node.wires[0])) {
        chatContext.set('currentConversationNode', node.id);
        chatContext.set('currentConversationNode_at', moment());
      }

      var chatLog = new ChatLog(chatContext);

      chatLog.log(msg, this.config.log)
        .then(function() {

          switch (type) {
            case 'message':
              node.telegramBot.sendMessage(chatId, msg.payload.content, msg.payload.options)
                .catch(node.error);
              break;
            case 'photo':
              node.telegramBot.sendPhoto(chatId, msg.payload.content, {
                caption: msg.payload.caption
              }).catch(node.error);
              break;
            case 'document':
              node.telegramBot.sendDocument(chatId, msg.payload.content, msg.payload.options)
                .catch(node.error);
              break;
            case 'sticker':
              node.telegramBot.sendSticker(chatId, msg.payload.content, msg.payload.options)
                .catch(node.error);
              break;
            case 'video':
              node.telegramBot.sendVideo(chatId, msg.payload.content, msg.payload.options)
                .catch(node.error);
              break;
            case 'audio':
              node.telegramBot.sendVoice(chatId, msg.payload.content, msg.payload.options)
                .catch(node.error);
              break;
            case 'location':
              node.telegramBot.sendLocation(chatId, msg.payload.content.latitude, msg.payload.content.longitude, msg.payload.options)
                .catch(node.error);
              break;
            case 'action':
              node.telegramBot.sendChatAction(chatId, msg.payload.waitingType != null ? msg.payload.waitingType : 'typing')
                .catch(node.error);
              break;
            case 'request':
              var keyboard = null;
              if (msg.payload.requestType === 'location') {
                keyboard = [
                  [{
                    text: !_.isEmpty(msg.payload.buttonLabel) ? msg.payload.buttonLabel : 'Send your position',
                    request_location: true
                  }]
                ];
              } else if (msg.payload.requestType === 'phone-number') {
                keyboard = [
                  [{
                    text: !_.isEmpty(msg.payload.buttonLabel) ? msg.payload.buttonLabel : 'Send your phone number',
                    request_contact: true
                  }]
                ];
              }
              if (keyboard != null) {
                node.telegramBot
                  .sendMessage(chatId, msg.payload.content, {
                    reply_markup: JSON.stringify({
                      keyboard: keyboard,
                      'resize_keyboard': true,
                      'one_time_keyboard': true
                    })
                  })
                  .catch(node.error);
              } else {
                node.error('Request type not supported');
              }
              break;
            case 'inline-buttons':
              buttons = {
                reply_markup: JSON.stringify({
                  inline_keyboard: _(msg.payload.buttons).map(function(button) {
                    return [{text: button.label, callback_data: button.value}];
                  })
                })
              };
              // store the last buttons
              if (node.telegramBot.lastInlineButtons == null) {
                node.telegramBot.lastInlineButtons = {};
              }
              node.telegramBot.lastInlineButtons[chatId] = msg.payload.buttons;
              // finally send
              node.telegramBot.sendMessage(chatId, msg.payload.content, buttons)
                .catch(node.error);
              break;
            case 'buttons':
              if (_.isEmpty(msg.payload.content)) {
                node.error('Buttons node needs a non-empty message');
                return;
              }
              buttons = {
                reply_markup: JSON.stringify({
                  keyboard: _(msg.payload.buttons).map(function(button) {
                    return [button.value];
                  }),
                  resize_keyboard: true,
                  one_time_keyboard: true
                })
              };
              // finally send
              node.telegramBot.sendMessage(
                chatId,
                msg.payload.content,
                buttons
              ).catch(node.error);
              break;

            default:
            // unknown type, do nothing
          }

        });

    });
  }

  RED.nodes.registerType('chatbot-telegram-send', TelegramOutNode);
};
