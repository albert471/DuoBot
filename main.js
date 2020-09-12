//=====================================================================================    
//=====================================================================================
//                                  DuoBot.js
// * Basic discord bot written in Javascript (Discord.js)
// * When prompted, calculates duo and solo winrate for a given summoner
// * @author: Albert471
// * @version: 1.5.2
//=====================================================================================

//todo:  add more features, bug test concurrency/other regions/edge cases/error cases/caching
// fix max number of duos bug (currently just ccuts off before character limit)
// for embeds: have it calculate how many large inlines it needs depending on # of duos
// then remember the 6k char cap (set a var t o5k and have it update whenever you make it bigger)

/** API related variables **/
const api = ""; //Riot API key
const disctoken = ``; //Discord Token
const adminId = `195767603476692992`; //User Id of the person with access to !duo guild stats
/** Libraries the bot requires **/
const Discord = require(`discord.js`);
const client = new Discord.Client();
client.login(disctoken);
const fs = require(`fs`);
const TeemoJS = require('teemojs');
let tApi = TeemoJS(api);

/** League API-specific global variables **/
const seasonsstartepoch = 1578488400000; //start of season 10
const clashqueue = 700;
const flexqueue = 440;
const soloduoqueue = 420;

/** Other global variables **/
let champjson = {};
let threshold = 3;
let queue = 0; //number of items in queue


/** Discord assorted variables */
const supportguild = `734110488870518855`;  //snowflake for support server
const duogeneral = `734110488870518859`; //snowflake for general chat
const duosupport = `734110528649298042`; //snowflake for support channel
const duosuggestions = `734111127092461619`; //suggestions channel;
const duofaq = `740148839406633051`; // faq channel

/** emojis and reaction functions here */ 
const xmark = `❌`;
const flexemoji = `744349180448866394`;
const soloemoji = `744349540609687633`;
const bothemoji = `744349716967325787`;
const trashemoji = `744349998287814849`;

//converts human readable regions to ones the bot uses 
const regionendpoint = {
    "na": "na1",
    "euw": "euw1",
    "eune": "eun1",
    "jp": "jp1",
    "kr": "kr",
    "lan": "la1",
    "las": "la2",
    "oce": "oc1",
    "tr": "tr1",
    "ru": "ru"
};
//convert bot region back to nicer ones for people
const regionReverse = {
    "na1": "na",
    "euw1": "euw",
    "eun1": "eune",
    "jp1": "jp",
    "kr": "kr",
    "la1": "lan",
    "la2": "las",
    "oc1": "oce",
    "tr1": "tr",
    "ru": "ru"
};

//reads champion file to the champjson object
async function loadChamps() {
    let data = fs.readFileSync(`champions.txt`);
    if (data.toString(`utf8`) == ``) {
        console.error("error");
    } else {
        champjson = JSON.parse(data.toString(`utf8`).trim());
    }
}

/** retrieves the cached game file and loads it as the object matchcache **/
async function getCache(summid) {
    let path = `./matches/${summid}.txt`;
    let dirPath = `./matches/`;
    try {
        if (!(fs.existsSync(dirPath))) {
            fs.mkdirSync(dirPath);
        }
        if (fs.existsSync(path)) {
            let retrievematchcache = await fs.readFileSync(path);
            if (retrievematchcache.toString(`utf8`) == ``) {
                return {};
            } else {
                return await JSON.parse(retrievematchcache.toString(`utf8`).trim());
            }
        }
        return {};
    } catch(err) {
        console.error(err);
        return {};
    }
}

/** saves data to the file for summid */
async function saveFile(data, summid) {
    fs.writeFile(`./matches/${summid}.txt`, data, (err) => 
    { if (err) throw err; });
}

/** gets the summoner and account IDs for summoner specified by S on server SERVER 
returns an array with [accountid, summonerid]. **/
async function getID(s,server) {
    // pull account id
    let dataArray = [];
    await tApi.get(server, 'summoner.getBySummonerName', s)
    .then(data => {
        if (data != null) {
            dataArray = [data.accountId, data.id];
        }
        return dataArray;
    })
    .catch(err => {
        dataArray = [];
        console.error(err);
        return dataArray;
    });
    return dataArray;
}


/** populates the matchistory array with the games played in QUEUE
keep searching until nothing is returned **/
async function getmatchhistory(queue,region, accountid) {
    let matchhistory = [];
    let counter = 0;
    let numreturned = -1;
    while (numreturned == -1 || numreturned > 0) {
        await tApi.get(region, 'match.getMatchlist', accountid, { queue: queue, beginTime: seasonsstartepoch, beginIndex: counter })
        .then(data => {
            counter += 100;
            if (data == null || data == undefined || data.matches == undefined) {
                numreturned = 0;
                return;
            }
            numreturned = data.matches.length;
            for (let x=0; x < numreturned; x++) {
                matchhistory.push(data.matches[x].gameId);
            }
        });
    }
    return matchhistory;
}

/** saves all info about the match with MATCHID to the matchcache if it isn't there already **/
async function getMatchInfo(matchid, region, matchcache, summoner) {
    
    if (matchid in matchcache) {
        return matchcache[matchid];
    }
    await tApi.get(region, 'match.getMatch', matchid)
        .then(async data => {
            matchcache[matchid] = data;
            await saveFile(JSON.stringify(matchcache), summoner);
        });
}

/** calculates teammates and adds them to the teammates object. **/
function getTeammates(matchid, teammates, accountid, matchcache) {
    if (!matchcache[matchid]) {
        return teammates;
    }
    if (matchcache[matchid].gameDuration < 300) {
        return teammates;
    }
    //find participantid of analyzed player by matching accountId
    const partId = matchcache[matchid].participantIdentities;
    let foundId = partId.find(p => {
        return p.player.accountId == accountid || accountid == p.player.currentAccountId;
    })
    if (foundId) {
        foundId = foundId.participantId;
    } else {
        console.error(`error in getTeammates: m.id = ${matchid}, accountid: ${accountid}`);
        return;
    }
    //find team of summoner
    const part = matchcache[matchid].participants;
    let teamId = part.find(pl => {
        return pl.participantId == foundId;
    })
    if (teamId) {
        teamId = teamId.teamId;
    } else {
        console.error(`error in getTeammates: m.id = ${matchid}, accountid: ${accountid}`);
        return;
    }
    //find teammates; pull partId using teammates[posn]['participantId']
    let teammatesarr = [];
    for (let y=0; y<part.length; y++) {
        if (part[y].teamId == teamId) {
            teammatesarr.push(part[y].participantId);
        }
    }
    //add them
    for (let x=0; x < teammatesarr.length; x++) {
        let teammatepid = teammatesarr[x];
        let teammate = partId.find(pl => {
            return pl.participantId == teammatepid && pl.player.accountId != accountid && pl.player.currentAccountId != accountid;
        });
        if (teammate) {
            teammate = teammate.player;
            if (!teammates[teammate.summonerName]) {
                teammates[teammate.summonerName] = [];
            }
            teammates[teammate.summonerName].push(matchid);
        }
    }
    return teammates;
}

/** returns whether the searched summer won MATCHID.  function errors if they didnt play */
function getWinOrLoss(matchid, accountid, matchcache) {
    if (!(matchid in matchcache)) return;
    // get participantid of searched player
    const partId = matchcache[matchid].participantIdentities;
    let foundId = partId.find(p => {
        return p.player.accountId == accountid || accountid == p.player.currentAccountId;
    })
    if (foundId) {
        foundId = foundId.participantId;
    } else {
        console.error(`error in getwinorloss: m.id = ${matchid}, accountid: ${accountid}`);
        return false;
    }
    // get participant from participantid
    const part = matchcache[matchid].participants;
    return part.find(pl => {
        return pl.participantId == foundId;
    }).stats.win;
}

/** returns true if the searched summoner was on blue team in MATCHID.  function errors if they didnt play */
function getBlueOrRed(matchid, accountid, matchcache) {
    if (!(matchid in matchcache)) return;
    // get participantid of searched player
    const partId = matchcache[matchid].participantIdentities;
    let foundId = partId.find(p => {
        return p.player.accountId == accountid || accountid == p.player.currentAccountId;
    })
    if (foundId) {
        foundId = foundId.participantId;
    } else {
        console.error(`error in getblueorred: m.id = ${matchid}, accountid: ${accountid}`);
        return;
    }
    // get participant from participantid
    const part = matchcache[matchid].participants;
    return part.find(pl => {
        return pl.participantId == foundId;
    }).teamId === 100 ? true : false;
}

/** returns true if the two matches have the same queue.  soft errors if it doesn't exist */
function compareQueues(matchid1, matchid2, matchcache) {
    if (matchid1 in matchcache && matchid2 in matchcache) {
        let queue1 = matchcache[matchid1].queueId;
        let queue2 = matchcache[matchid2].queueId;
        return queue1 == queue2; 
    }
    return false;
}

/** takes all duo games from the duo object, adds them all to duomatchhistory.  calculates % wr of
duo games as well as solo games.  lastly, calculates wr with specific duos
threshold: integer number of games a teammate appears before they are a duo (default: 3) 
returns [duos won, duos played, solos won, solos played, total played, duoers object]**/
function finalanalysis(threshold, teammates, matchhistory, accountid, matchcache) {
    //match ids with a duo
    let duogames = [],
        duogameswon = 0;
    const allplayers = Object.keys(teammates);
    //summoner names of duos
    let duoers = {};
    for (let i=0; i < allplayers.length; i++) {
        if (teammates[allplayers[i]].length >= threshold) {
            duoers[allplayers[i]] = teammates[allplayers[i]];
        }
    }
    for (let x=0; x<allplayers.length; x++) {
        if (teammates[allplayers[x]].length >= threshold) {
            duogames = duogames.concat(teammates[allplayers[x]]);
        }
    }
    let duogamesUnique = duogames.filter(function(elem, pos) {
        return duogames.indexOf(elem) == pos;
    });
    for (let y=0; y<duogamesUnique.length; y++) {
        if (getWinOrLoss(duogamesUnique[y], accountid, matchcache)) {
            duogameswon++;
        }
    }
    //filter out remake games from matchhistory
    let matchtemp = matchhistory.filter(m => {
        return matchcache[m].gameDuration > 300;
    });
    matchhistory = matchtemp;
    let sologames = [],
        sologameswon = 0;
    //get sologames by finding games not in duo cache
    for (let z=0; z<matchhistory.length; z++) {
        if (!duogamesUnique.includes(matchhistory[z])) {
            sologames.push(matchhistory[z]);
        }
    }
    for (let a=0; a<sologames.length; a++) {
        if (getWinOrLoss(sologames[a], accountid, matchcache)) {
            sologameswon++;
        }
    }
    Object.keys(duoers).forEach(key => {
        let counter = 0;
        for (let b=0; b<duoers[key].length; b++) {
            if (getWinOrLoss(duoers[key][b], accountid, matchcache)) {
                counter++;
            }
        }
        duoers[key] = [counter, duoers[key].length];
    });
    let duogamesplayed = duogamesUnique.length,
        sologamesplayed = sologames.length;
    let totalgamesplayed = sologamesplayed + duogamesplayed;
    return [duogameswon, duogamesplayed, sologameswon, sologamesplayed, totalgamesplayed, duoers];
}

/** Returns a timestamp for the given epoch **/
function getTimeStamp(time)
{
    let today = new Date();
    let date = `${(today.getMonth() + 1)}-${today.getDate()}`;
    //make it proper military time
    let theHour = today.getHours();
    if (theHour < 10) theHour = `0${theHour.toString()}`;
    let theMinute = today.getMinutes();
    if (theMinute < 10) theMinute = `0${theMinute.toString()}`;
    let theSecond = today.getSeconds();
    if (theSecond < 10) theSecond = `0${theSecond.toString()}`;
    let times = `${theHour}:${theMinute}:${theSecond}`;
    let dateTime = `${date} ${times}`;
    return dateTime;
}

/** performs an insertion sort on the mostly-sorted matchhistory ARRAY */
function insertionSort(array, matchcache) {
  for (let i = 1; i < array.length; i++) {
    let j = i - 1;
    let temp = array[i];
    while (j >= 0 && matchcache[array[j]] < matchcache[temp]) { 
      array[j + 1] = array[j];
      j--;
    }
    array[j+1] = temp;
  }
  return array;
}

/** create and return the boilerplate of an embed . */
/** afterwards, you need to add fields and the description */
function createEmbed(title, description) {
    let color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    const embed = new Discord.MessageEmbed()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setAuthor('DuoBot', 'https://github.com/albert471/DuoBot/blob/master/Images/duo.jpg?raw=true', 'https://discord.gg/zdAajBZ')
    .setThumbnail('https://github.com/albert471/DuoBot/blob/master/Images/duo.jpg?raw=true')
    .setTimestamp()
    .setFooter('Contact me at APotS#8566 for questions or feedback', 'https://github.com/albert471/DuoBot/blob/master/Images/duo.jpg?raw=true');
    return embed;

}
/** returns the name of the champ with the given ID **/
function getChampFromId(id) {
    return Object.keys(champjson.data).filter( c => {
        return parseInt(champjson.data[c].key) == id;
    })[0];
}

async function reactToEmbed(sentmsg, type, noMatch) {
    if (type == `(Flex and Solo Queue)` && !noMatch) {
        sentmsg.react(flexemoji);
        sentmsg.react(soloemoji);
    } else if (type == `(Solo Queue Only)`) {
        sentmsg.react(flexemoji);
        sentmsg.react(bothemoji);
    } else if (type == `(Flex Queue Only)`) {
        sentmsg.react(soloemoji);
        sentmsg.react(bothemoji);
    }
    sentmsg.react(trashemoji);
}
/**               Client ready listener
    performs these commands when bot is turned on    **/
client.on(`ready`, () => 
{
    //functions found near bottom
   onReady.consoleLog();
   onReady.getReady(); 
   
   //update bot status
    onReady.setPresence();
});


/**                   Client on.message event listener
iterates through these functions when the bot receives a message. **/
client.on(`message`, (receivedMessage) => 
{
    //ignore dms and bots
    if (receivedMessage.guild == null) return;
    if (receivedMessage.author.bot) return;

    //the lookup bot: !User [region] [name] ie !duo na hugs
    // losers queue: !duolosers [region] [name] !duolosers na hugs
    if (receivedMessage.content.search(/^!duo/i) > -1) {
        if (receivedMessage.author.id == adminId) {
            onMessage.adminCommands(receivedMessage);
        }
        onMessage.lookupMsg(receivedMessage);
        return;
    }
});

//                  Client on.messagereactionadd event listener
/** changes the embed to flex only, solo only, or both deending on the reaction   */
client.on('messageReactionAdd', (reaction, user) => {
    if (user.id == client.user.id) return;
    //only include messages this bot sent
    if (reaction.message.author.id == client.user.id) {
        //make sure the bot is accepting reacts
        onMessageReactionAdd.changeType(reaction);
    }
});

//                  Client on.ServerJoin event listener
// iterates through these statements when the bot receives a message.
client.on(`guildMemberAdd`, (member) => 
{
    //only notify for support guild
    if (member.guild.id == supportguild) {
        onJoin.introduction(member);
    }
});

/** fns for when a reaction is added */
const onMessageReactionAdd = {
    async changeType(reaction) {
        if (reaction.message.deleted) {
            return;
        }
        const reactionMngr = reaction.message.reactions.cache;
        let reactcountarr = [];
        let flexreactcount = reactionMngr.get(flexemoji);
        reactcountarr.push(flexreactcount);
        let soloreactcount = reactionMngr.get(soloemoji);
        reactcountarr.push(soloreactcount);
        let bothreactcount = reactionMngr.get(bothemoji);
        reactcountarr.push(bothreactcount);
        let trashreactcount = reactionMngr.get(trashemoji);
        reactcountarr.push(trashreactcount);
        let totalreactionsum = 0;
        let totalmissing = 0;
        for (let k of reactcountarr) {
            if (k && k.count > 1) {
                totalreactionsum++;
            }
        } 
        if (totalreactionsum != 1) {
            return;
        }
        let booleanbotreacted = reaction.me;
        let reactedCount = reaction.count;
        if (booleanbotreacted && reactedCount > 1) {
            let checkType = reaction.emoji.id;
            //need some if statements to get type from this
            let embTitle = reaction.message.embeds[0].title;
            let reg = /^(Duo[\w]{0,10}) statistics for (.{3,16}) on the ([\w\d]{2,4}) server$/i;
            let matches = embTitle.match(reg); //takes form [analysisType, summoner, region]
            if (!matches || matches.length != 4) {
                console.error("error at messagereactionadd");
                return;
            } 
            let chn = reaction.message.channel;
            await reaction.message.delete().catch((err) => { console.error(err); });
            if (checkType == flexemoji || checkType == soloemoji || checkType == bothemoji) {
                chn.send(`Searching again for ${matches[2]} on the ${matches[3]} server...`)
                .then(async (message) => {
                    joinQueue();
                    let ids = await getID(matches[2], regionendpoint[matches[3]]);
                    if (ids.length != 2) {
                        message.edit(`Error finding this summoner and region combination.`);
                        leaveQueue();
                        return;
                    }
                    let accountid = ids[0];
                    //await reaction.message.suppressEmbeds(false);
                    let theType;
                    switch (checkType) {
                        case flexemoji:
                            theType = `(Flex Queue Only)`;
                            break;
                        case soloemoji:
                            theType = `(Solo Queue Only)`;
                            break;
                        case bothemoji:
                            theType = `(Flex and Solo Queue)`;
                            break;
                        default:
                            console.error(`error in changetype switch command :checkType = ${checkType}`);
                            leaveQueue();
                            return;
                    }
                    await onMessage.matchHistoryAndAnalysis(accountid, matches[2], regionendpoint[matches[3]], message,theType, matches[1].toLowerCase());
                })
                .catch(err => {
                    console.error(err);
                    return;
                });
            } else if (!(checkType == trashemoji)) {
                console.error(`error in changetype: unknown emote rxn: checkType ${checkType}`);
                return;
            }
        }
    }
};
/** Functions to be performed when the bot is turned on **/
const onReady = 
{
   //console.Log() logs the user's name to the console after login
  consoleLog()
  {
    //stuff that makes the console look nice (might xport this to a log file later)
    console.log(`\n\n=-----------------------------------------------------------=`);
    console.log(`\n                  DuoBot!`);
    console.log(`\n\n=-----------------------------------------------------------=`);
    console.log(`\nInformation will appear here when bot actions are triggered.`);
    console.log(`Bot loaded successfully`);
  console.log(`Logged in as ${client.user.tag}!`);
  },
  setPresence(RateLimited)
    {
        //if ratelimited, make status indicate that there will be a wait
        if (RateLimited == true) {
            let game = `with someone (Busy -- possible delay)    Help command: !duo help`;
            client.user.setActivity(game, { type: `PLAYING` });
        } else {
            let game = `TV (Free to handle requests)    Help command: !duo help`;
            client.user.setActivity(game, { type: `WATCHING`});
        }
    },
    async getReady() {
        await loadChamps();
    }
};
const onJoin = {
    /** Introduce people when they join the support server and show them around */
    introduction(member) {
        let replyMessage = `Hi <@${member.id}>, welcome to the DuoBot support server.\n`;
        replyMessage += `You can find answers to commonly asked questions in <#${duofaq}>.\n`;
        replyMessage += `If you have any questions or feedback, please direct them to <#${duosupport}> or <#${duosuggestions}> respectively.\n`;
        replyMessage += `If the bot is down or something is urgent, please ping the dev. Enjoy your stay!`;
        const gen = member.guild.channels.cache.get(duogeneral);
        if (gen) {
            gen.send(replyMessage);
        } else {
            console.log('could not find gen chat');
        }
    }
};
const onMessage =  {
    async losers(matchhistory, accountid, sentmsg, summonerName, region, matchcache, type) {
        let totalstreakarray = [];
        let totalwon = 0;
        let remakecount = 0;
        let longeststreak = 0;
        for (let streak = 1; streak <= 4; streak++) {
            //matchhistory array is in backwards order, so we need to iterate in reverse
            //in addition, there is a split between solo/flex, so it has to account for that as well
            let currentstreak = 0;
            let totalcounted = 0;
            let won = 0;
            for (let x=matchhistory.length - 1; x >= 0; x--) {
                let queuecheck = x < matchhistory.length - 1 ? compareQueues(matchhistory[x], matchhistory[x+1], matchcache) : true;
                if (matchcache[matchhistory[x]].gameDuration <= 300) {
                    remakecount++;
                    continue;
                }
                let wonThisOne = getWinOrLoss(matchhistory[x], accountid, matchcache);
                if (currentstreak >= streak && queuecheck) {
                    totalcounted++;
                    if (wonThisOne) {
                        won++;
                    }
                }
                if (wonThisOne) {
                    totalwon++;
                    currentstreak = 0;
                } else if (!queuecheck) {
                    currentstreak = 1;
                } else {
                    currentstreak++;
                    if (currentstreak >= longeststreak) {
                        longeststreak = currentstreak;
                    }
                }
            }
            totalstreakarray.push(won);
            totalstreakarray.push(totalcounted);
        }
        totalwon = totalwon / 4; //counted each match 4 times, so have to divide here
        remakecount = remakecount / 4;
        let totalwinrate = `${parseFloat(totalwon/(matchhistory.length - remakecount)*100).toFixed(2)}%`;
        //analyzed matchhistory.length matches, found totalstreakarray[1,3,5,7] games respectively with winrates...
        const embed = createEmbed(`Duolosers statistics for ${summonerName} on the ${regionReverse[region]} server`,`Calculated Loss Streak Information ${type}`);
        embed.addFields(
                { name: 'All Ranked Games:', value: 'Played ' + (matchhistory.length - remakecount) + ', Won ' + totalwon + ", Winrate: " + totalwinrate}
            );
        for (let x=1; x <=4; x++) {
            let gamesplayed = totalstreakarray[2*x-1];
            let gameswon = totalstreakarray[2*x-2];
            let winr = gamesplayed == 0 ? `N/A` : `${parseFloat(gameswon/gamesplayed * 100).toFixed(2)}%`;
            embed.addField(`Games played on ${x}+ loss streak:`, `Played ${gamesplayed}, Won ${gameswon}, Winrate: ${winr}`, false);
        }
        embed.addField(`Longest losing streak in a ranked queue:`, longeststreak, true);
        await sentmsg.edit(`Loss Streak Statistics for ${summonerName}.`);
        sentmsg.edit(embed);
        reactToEmbed(sentmsg, type);

    },
    async length(matchhistory, accountid, sentmsg, summonerName, region, matchcache, type) {
        let sub20Data = {}, 
            sub25Data = {},
            sub30Data = {},
            sub35Data = {},
            sub40Data = {},
            over40Data = {},
            longestgamelength = [0,0],
            shortestgamelength = [0,0],
            shortestwinorloss = ``,
            longestwinorloss = ``,
            blueCount = 0,
            blueWins = 0,
            redCount = 0,
            redWins = 0;
        let allLengthData = [sub20Data, sub25Data, sub30Data, sub35Data, sub40Data, over40Data];
        for (let x=0; x < allLengthData.length; x++) {
            allLengthData[x]["count"] = 0;
            allLengthData[x]["won"] = 0;
        }
        for (let x=0; x < matchhistory.length; x++) {
            const duration = matchcache[matchhistory[x]].gameDuration;
            if (duration <= 300) {
                continue;
            } else {
                //blue red winrates
                let blueOrRed = getBlueOrRed(matchhistory[x], accountid, matchcache);
                if (blueOrRed == true) {
                    blueCount++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        blueWins++;
                    }
                } else if (blueOrRed == false) {
                    redCount++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        redWins++;
                    }
                } else {
                    console.error(`error in async length: blueOrRed: ${blueOrRed}`);
                    return;
                }
                //duration winrates
                if (duration < 20*60) {
                    allLengthData[0]["count"]++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        allLengthData[0]["won"]++;
                    }
                } else if (duration < 25*60) {
                    allLengthData[1]["count"]++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        allLengthData[1]["won"]++;
                    }
                } else if (duration < 30*60) {
                    allLengthData[2]["count"]++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        allLengthData[2]["won"]++;
                    }
                } else if (duration < 35*60) {
                    allLengthData[3]["count"]++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        allLengthData[3]["won"]++;
                    }
                } else if (duration < 40*60) {
                    allLengthData[4]["count"]++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        allLengthData[4]["won"]++;
                    }
                } else if (duration >= 40*60) {
                    allLengthData[5]["count"]++;
                    if (getWinOrLoss(matchhistory[x], accountid, matchcache)) {
                        allLengthData[5]["won"]++;
                    }
                } else {
                    console.error(`error in async length: duration = ${duration}`);
                    return;
                }
            }
            if (duration > longestgamelength[0]) {
                longestgamelength[0] = duration;
                longestgamelength[1] = matchhistory[x];
            }
            if (duration < shortestgamelength[0] || shortestgamelength[0] === 0) {
                shortestgamelength[0] = duration;
                shortestgamelength[1] = matchhistory[x];
            }
        }
        for (let x=0; x < allLengthData.length; x++) {
                allLengthData[x]["winrate"] = `${parseFloat(allLengthData[x]["won"]/(allLengthData[x]["count"] || 1)*100).toFixed(2)}%`;
        }
        shortestwinorloss = getWinOrLoss(shortestgamelength[1], accountid, matchcache) == true ? `won` : `lost`;
        longestwinorloss = getWinOrLoss(longestgamelength[1], accountid, matchcache) == true ? `won` : `lost`;
        let longestGameDisplay = `${parseInt(longestgamelength[0] /  60)}:`;
        longestGameDisplay += `${longestgamelength[0] % 60}`.padStart(2,"0");
        let shortestGameDisplay = `${parseInt(shortestgamelength[0] / 60)}:`;
        shortestGameDisplay += `${shortestgamelength[0] % 60}`.padStart(2,"0");
        let blueWinrate = `${parseFloat(blueWins/(blueCount || 1)*100).toFixed(2)}%`;
        let redWinrate = `${parseFloat(redWins/(redCount || 1)*100).toFixed(2)}%`;
        const embed = createEmbed(`Duolength statistics for ${summonerName} on the ${regionReverse[region]} server`,`Calculated Game Length Information ${type}`);
        embed.addFields(
                { name: 'Games under 20 Minutes', value: 'Played ' + allLengthData[0]["count"] + ', Won ' + allLengthData[0]["won"] + ", Winrate: " + allLengthData[0]["winrate"]},
                { name: 'Games between 20-25 Minutes', value: 'Played ' + allLengthData[1]["count"] + ', Won ' + allLengthData[1]["won"] + ", Winrate: " + allLengthData[1]["winrate"]},
                { name: 'Games between 25-30 Minutes', value: 'Played ' + allLengthData[2]["count"] + ', Won ' + allLengthData[2]["won"] + ", Winrate: " + allLengthData[2]["winrate"]},
                { name: 'Games between 30-35 Minutes', value: 'Played ' + allLengthData[3]["count"] + ', Won ' + allLengthData[3]["won"] + ", Winrate: " + allLengthData[3]["winrate"]},
                { name: 'Games between 35-40 Minutes', value: 'Played ' + allLengthData[4]["count"] + ', Won ' + allLengthData[4]["won"] + ", Winrate: " + allLengthData[4]["winrate"]},
                { name: 'Games over 40 Minutes', value: 'Played ' + allLengthData[5]["count"] + ', Won ' + allLengthData[5]["won"] + ", Winrate: " + allLengthData[5]["winrate"]},
                { name: 'Games played on blue side', value: 'Played ' + blueCount + ', Won ' + blueWins + ", Winrate: " + blueWinrate},
                { name: 'Games played on red side', value: 'Played ' + redCount + ', Won ' + redWins + ", Winrate: " + redWinrate}
            );
        embed.addField(`Longest game length`, `${longestGameDisplay} (${longestwinorloss})`, true);
        embed.addField(`Shortest game length`, `${shortestGameDisplay} (${shortestwinorloss})`, true);
        await sentmsg.edit(`Game Length Statistics for ${summonerName}.`);
        sentmsg.edit(embed);
        reactToEmbed(sentmsg, type);
    },
    async duo(matchhistory, accountid, sentmsg, summonerName, region, matchcache, type) {
        if (type == undefined) type = `(Flex and Solo Queue)`;
        let teammates = {};
        for (let y=0; y < matchhistory.length; y++) {
            teammates = getTeammates(matchhistory[y], teammates, accountid, matchcache);
        }
        let finalarr = finalanalysis(threshold, teammates, matchhistory, accountid, matchcache);
        //finalarr is [duos won, duos played, solos won, solos played, total played, duoers object]
        let duowr = finalarr[0]/finalarr[1]*100;
        let solowr = finalarr[2]/finalarr[3]*100;
        let totalwon = finalarr[0] + finalarr[2];
        let totalwr = totalwon/finalarr[4]*100;
        let winrateArray = [duowr, solowr, totalwr];
        //handle NaN% bug
        for (let x=0; x<winrateArray.length; x++) {
            winrateArray[x] = Number.isNaN(winrateArray[x]) ? `N/A` : `${parseFloat(winrateArray[x]).toFixed(2)}%`;
        }
        const embed = createEmbed(`Duo statistics for ${summonerName} on the ${regionReverse[region]} server`, `Calculated Duo Information ${type}`);
        embed.addFields(
                { name: 'All Ranked Games:', value: 'Played ' + finalarr[4] + ', Won ' + totalwon + ", Winrate: " + winrateArray[2]},
                { name: 'Games With a Duo:', value: 'Played ' + finalarr[1] + ', Won ' + finalarr[0] + ", Winrate: " + winrateArray[0]},
                { name: 'Games Without a Duo:', value: 'Played ' + finalarr[3] + ', Won ' + finalarr[2] + ", Winrate: " + winrateArray[1]},
                { name: '\u200B', value: '\u200B' }
            );
        let duoSorted = Object.keys(finalarr[5]).sort((a,b) => {
            return finalarr[5][b][1] - finalarr[5][a][1];
        });
        if (duoSorted.length > 0) {
            embed.addField('Duos (minimum 3 games played together):',"Win-Loss records for each of your duos.", false);
        }
        let maxInlines = 18;
        duoSorted.forEach(key => {
            if (maxInlines > 0) {
                let inline = `${finalarr[5][key][0]}-${finalarr[5][key][1]-finalarr[5][key][0]}`;
                embed.addField(key, inline, true);
                maxInlines--;
            }
        });
        let currchars = 0;
        if (duoSorted.length > 18) {
            let lastline = "";
            for (let x=18; x<duoSorted.length; x++) {
                if (currchars > 990) break;
                let duoArray = finalarr[5][duoSorted[x]];
                let newline = `**${duoSorted[x]}:** ${duoArray[0]}-${duoArray[1]-duoArray[0]}\n`;
                currchars += newline.length;
                lastline += newline;
            }
            embed.addField('Other Duos:', lastline, false);
        }
        await sentmsg.edit(`Duo Statistics for ${summonerName}.`);
        sentmsg.edit(embed);
        reactToEmbed(sentmsg, type);
    },
    async lookupMsg(receivedMessage)
    {
        let message = receivedMessage.content;
        let summonerName = ``;
        //use regex to find the region and summoner name
        let region = message.match(/(?<=!duo |!duolosers |!duolength )[\w]+/i);
        if (!region || region.length != 1) {
            receivedMessage.react(xmark);
            return false;
        }
        region = region[0].toLowerCase();
        if (region == "help") {
            onMessage.help(receivedMessage);
            return;
        } else if (!Object.keys(regionendpoint).includes(region)) {
            receivedMessage.react(xmark);
            return false;
        }
        region = regionendpoint[region];
        let reg = /(?<=!duo [\w]+ |!duolosers [\w]+ |!duolength [\w]+ )[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿąćęıłńœśšźżžƒÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞŸĄĆĘIŁŃŒŚŠŹŻŽªºßˆˇˉﬁﬂµμ\w\d\s]+/i;
        summonerName = message.match(reg);
        if (!summonerName || summonerName.length != 1) {
            receivedMessage.react(xmark);
            return false;
        }
        summonerName = summonerName[0].toLowerCase();
        if (summonerName.length > 16 || summonerName.length < 3) {
            receivedMessage.react(xmark);
            return false;
        }
        let replymessage = `Searching for summoner name: '${summonerName}'`;
        replymessage += ` on the ${regionReverse[region]} server...`;
        receivedMessage.channel.send(replymessage)
        .then(async (message) => {
            joinQueue();
            let ids = await getID(summonerName, region);
            if (ids.length != 2) {
                message.edit(`Error finding this summoner and region combination.`);
                leaveQueue();
                return;
            }
            let accountid = ids[0],
                summonerid = ids[1];
            message.edit(`Summoner found. Updating matches... (this might take a while)`);
            let analysisType;
            if (receivedMessage.content.search(/^!duo /i) > -1) {
                analysisType = "duo";
            } else if (receivedMessage.content.search(/^!duolosers /i) > -1) {
                analysisType = "duolosers";
            } else if (receivedMessage.content.search(/^!duolength /i) > -1) {
                analysisType = "duolength";
            } else {
                console.error(`error in lookupmsg: query: ${receivedMessage.content}`);
                return;
            }
            const senderTag = receivedMessage.author.tag;
            const time = getTimeStamp();
            const query = receivedMessage.content;
            saveToLog(`${time}: ${senderTag}: ${query}\n`);
            await onMessage.matchHistoryAndAnalysis(accountid, summonerName, region, message, `(Flex and Solo Queue)`, analysisType);
            
        });
    },
    /**populates match history array and matchcache for the given summoner (and acc id) and region.  Message is the bot's message, type is 
    flex/solo/both, analysistype is duolosers or duo                           */
    async matchHistoryAndAnalysis(accountid, summonerName, region, message, type, analysisType) {
        let matchhistory = [];
        let matchcache = await getCache(accountid);
        if (type == `(Flex and Solo Queue)` || type == `(Solo Queue Only)`) {
            let solom = await getmatchhistory(soloduoqueue, region, accountid);
            solom = insertionSort(solom, matchcache);
            matchhistory = matchhistory.concat(solom);
        }
        if (type == `(Flex and Solo Queue)` || type == `(Flex Queue Only)`) {
            let flexm = await getmatchhistory(flexqueue, region, accountid);
            flexm = insertionSort(flexm, matchcache);
            matchhistory = matchhistory.concat(flexm);
        }
        //now api search the matches
        for (let x=0; x < matchhistory.length; x++) {
            //progress bar halfway through
            if (x == Math.floor(matchhistory.length / 2)) {
                await message.edit(`Summoner found. Updating matches... (this might take a while)\n Progress: ${x}/${matchhistory.length}.`);
            }
            await getMatchInfo(matchhistory[x], region, matchcache, accountid);
        }

        //send the matches off to the correct analysis function
        if (analysisType == "duo") {
            onMessage.duo(matchhistory, accountid, message, summonerName, region, matchcache, type);
        } else if (analysisType == "duolosers") {
            onMessage.losers(matchhistory, accountid, message, summonerName, region, matchcache, type);
        } else if (analysisType == "duolength") {
            onMessage.length(matchhistory, accountid, message, summonerName, region, matchcache, type);
        } else {
            console.error(`error in matchhistoryandanalysis: analysisType = ${analysisType}`);
        }
        leaveQueue();
    },
    help(receivedMessage) {
        let replyMessage = `Hi, I'm DuoBot.  If you would like to search your summoner, please use the following commands: \n`;
        replyMessage += `Duo Winrate: !duo [region] [summoner]  (as an example: !duo na albert471)\n`;
        replyMessage += `Loss Statistics: !duolosers [region] [summoner]  (as an example: !duolosers na albert471)\n`;
        replyMessage += `Length Statistics: !duolength [region] [summoner]  (as an example: !duolength na albert471)\n`;
        replyMessage += `Have questions, feedback, or a bug to report? Message me at APotS#8566 or join <https://discord.gg/zdAajBZ>.`;
        receivedMessage.channel.send(replyMessage);
    },
    adminCommands(receivedMessage) { //hardcoding some admin commands;
        if (receivedMessage.content == `!duo guild stats`) {
            let replyMessage = `guilds and owners:\n`;
            let ownerObject = {};
            client.guilds.cache.each((guild) => {
                if (replyMessage.length <= 1900) {
                    let text = ``;
                    if (guild.owner) {
                        text = `${guild.owner.displayName} ${guild.owner.id}`;
                    }
                    if (!ownerObject[guild.ownerID]) {
                        ownerObject[guild.ownerID] = 1;
                    } else {
                        ownerObject[guild.ownerID]++;
                    }
                    replyMessage += `${guild.name}: ${text}\n`;
                }
            });
            let total = 0;
            for (let x of Object.values(ownerObject)) {
                replyMessage += `${x} `;
                total += x;
            }
            replyMessage += `\nTotal = ${total}`;
            receivedMessage.channel.send(replyMessage);
        }
    }
};

/** Handles number of active threads. When count is 0, status changes to "not busy". **/
function leaveQueue() {
    queue--;
    if (queue == 0) {
        onReady.setPresence(false);
    } else {
        onReady.setPresence(true);
    }
}

function joinQueue() {
    queue++;
    if (queue == 1) {
        onReady.setPresence(true);
    }
}

async function saveToLog(info) {
    fs.appendFile("log.txt", info, function (err) {
    if (err) throw err;
    });
}