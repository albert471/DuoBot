//=====================================================================================    
//=====================================================================================
//                                  DuoBot.js
// * Basic discord bot written in Javascript (Discord.js)
// * When prompted, calculates duo and solo winrate for a given summoner
// * @author: Albert471
// * @version: 1.0.13
//=====================================================================================

//todo: turn message into embed, add more features, bug test concurrency/other regions/edge cases/error cases/ 
// if you want: change the way it stores players to acccount for name changes
// add a !duo help command
/** API related variables **/
const api = ""; //Riot API key
const apikey = `api_key=` + api; //alternative format

const disctoken = ``; //Discord Token

/** Libraries the bot requires **/
const Discord = require(`discord.js`);
const client = new Discord.Client();
client.login(disctoken);
const https = require('https');
const fs = require(`fs`);
const TeemoJS = require('teemojs');
let tApi = TeemoJS(api);

/** emojis instantiated here **/
const xmark = `❌`;
const checkmark = `✅`;

//check to make sure LAS vs LAN are la1 or la2
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
}

/** League API-specific global variables **/
const seasonsstartepoch = 1578488400; //start of season 10
const clashqueue = 700;
const flexqueue = 440;
const soloduoqueue = 420;

/** Other global variables **/
let summ = ''; //remember to set this from message event listener
let champjson = {};
let globalReplyMessage = ``;
let threshold = 3;
let queue = 0;

/* -------------------------------------*/
//reads champion file to the champjson object
async function loadChamps() {
	let data = fs.readFileSync(`champions.txt`);
	if (data.toString(`utf8`) == ``) {
	    console.log("error");
	} else {
	    champjson = JSON.parse(data.toString(`utf8`).trim());
	}
}

/* ---------------------------------------*/

/** retrieves the cached game file and loads it as the object matchcache **/
async function getCache() {
	let retrievematchcache = await fs.readFileSync(`matchcache.txt`);
    if (retrievematchcache.toString(`utf8`) == ``) {
    	matchcache = {};
    } else {
    	matchcache = await JSON.parse(retrievematchcache.toString(`utf8`).trim());
    }
}

/** gets the summoner and account IDs for summoner specified by S on server SERVER 
returns an array with [accountid, summonerid]. **/
async function getID(s,server) {
	// pull account id
	let dd = [];
	await tApi.get(server, 'summoner.getBySummonerName', s)
	.then(data => {
		if (data != null) {
			dd = [data.accountId, data.id];
		}
		return dd;
	})
	.catch(err => {
		dd = [];
		console.log(err);
		return dd;
	});
	return dd;
}


/** populates the mathistory array with the games played in QUEUE
keep searching until nothing is returned **/
async function getmatchhistory(queue,region, accountid) {
	let matchhistory = [];
	let counter = 0;
	let numreturned = -1;
	while (numreturned == -1 || numreturned > 0) {
		await tApi.get(region, 'match.getMatchlist', accountid, { queue: queue, beginTime: 1578477600000, beginIndex: counter })
		.then(data => {
			counter += 100;
			//console.log(data);
			if (data == null) {
				numreturned = 0;
				return;
			}
			numreturned = data['matches'].length;
			//console.log(data['matches'])
			for (let x=0; x < numreturned; x++) {
				//console.log(data['matches'][x])
				matchhistory.push(data['matches'][x]['gameId']);
			}
		});
	}
	return matchhistory;
}

/** saves all info about the match with MATCHID to the matchcache if it isn't there already **/
async function getMatchInfo(matchid, region) {
	if (matchid in matchcache) {
		//console.log('cached')
		return matchcache[matchid];
	}
	//console.log('not cached')
	await tApi.get(region, 'match.getMatch', matchid)
		.then(data => {
			matchcache[matchid] = data;
			fs.writeFile(`matchcache.txt`, JSON.stringify(matchcache), (err) => 
			{ if (err) throw err; });
		})
}

/** calculates teammates and adds them to the teammates object. **/
function analyzeMatch(matchid, teammates, accountid) {
	if (!matchcache[matchid]) {
		return teammates;
	}
	if (matchcache[matchid]['gameDuration'] < 300) {
		return teammates;
	}
	//find participantid of analyzed player by matching accountId
	const partId = matchcache[matchid]['participantIdentities'];
	let foundId = partId.find(p => {
		//console.log(p['player']['accountId'])
		//console.log(accountid);
		return p['player']['accountId'] == accountid;
	})['participantId'];
	//find team of summoner
	const part = matchcache[matchid]['participants'];
	let teamId = part.find(pl => {
		return pl['participantId'] == foundId;
	})['teamId'];
	//find teammates; pull partId using teammates[posn]['participantId']
	let teammatesarr = [];
	for (let y=0; y<part.length; y++) {
		if (part[y]['teamId'] == teamId) {
			teammatesarr.push(part[y]['participantId']);
		}
	}
	//add them
	for (let x=0; x < teammatesarr.length; x++) {
		let teammatepid = teammatesarr[x];
		let teammate = partId.find(pl => {
			return pl['participantId'] == teammatepid && pl['player']['accountId'] != accountid;
		});
		if (teammate) {
			teammate = teammate['player'];
			if (!teammates[teammate['summonerName']]) {
				teammates[teammate['summonerName']] = [];
			}
			teammates[teammate['summonerName']].push(matchid);
		}
	}
	return teammates;
}

/** returns whether the searched summer won MATCHID.  function errors if they didnt play */
function getWinOrLoss(matchid, accountid) {
	if (!matchid in matchcache) {
		return;
	}
	// get participantid of searched player
	const partId = matchcache[matchid]['participantIdentities'];
	let foundId = partId.find(p => {
		return p['player']['accountId'] == accountid;
	})['participantId'];
	// get participant from participantid
	const part = matchcache[matchid]['participants'];
	return part.find(pl => {
		return pl['participantId'] == foundId;
	})['stats']['win'];
}

/** takes all duo games from the duo object, adds them all to duomatchhistory.  calculates % wr of
duo games as well as solo games.  lastly, calculates wr with specific duos
threshold: integer number of games a teammate appears before they are a duo (default: 3) 
returns [duos won, duos played, solos won, solos played, total played, duoers object]**/
function finalanalysis(threshold, teammates, matchhistory, accountid) {
	//match ids with a duo
	let duogames = [];
	let duogameswon = 0;
	const allplayers = Object.keys(teammates);
	//summoner names of duos
	let duoers = {};
	for (let i=0; i < allplayers.length; i++) {
		if (teammates[allplayers[i]].length >= threshold) {
			duoers[allplayers[i]] = teammates[allplayers[i]];
		}
	}
	//console.log(duoers);
	for (let x=0; x<allplayers.length; x++) {
		if (teammates[allplayers[x]].length >= threshold) {
			duogames = duogames.concat(teammates[allplayers[x]])
		}
	}
	duogamesUnique = duogames.filter(function(elem, pos) {
    	return duogames.indexOf(elem) == pos;
    })
    for (let y=0; y<duogamesUnique.length; y++) {
    	if (getWinOrLoss(duogamesUnique[y], accountid)) {
    		duogameswon++;
    	}
    }
    //filter out remake games from matchhistory
    matchtemp = matchhistory.filter(m => {
    	return matchcache[m]['gameDuration'] > 300;
    });
    matchhistory = matchtemp;

    sologames = [];
    sologameswon = 0;
    //get sologames by finding games not in duo cache
    for (let z=0; z<matchhistory.length; z++) {
    	if (!duogamesUnique.includes(matchhistory[z])) {
    		sologames.push(matchhistory[z]);
    	}
    }
    for (let a=0; a<sologames.length; a++) {
    	if (getWinOrLoss(sologames[a], accountid)) {
    		sologameswon++;
    	}
    }
    Object.keys(duoers).forEach(key => {
    	counter = 0;
    	for (let b=0; b<duoers[key].length; b++) {
    		if (getWinOrLoss(duoers[key][b], accountid)) {
    			counter++;
    		}
    	}
    	duoers[key] = [counter, duoers[key].length];
    });

    totalgamesplayed = matchhistory.length;
    duogamesplayed = duogamesUnique.length;
    sologamesplayed = sologames.length;
    totalgamesplayed = sologamesplayed + duogamesplayed;
    return [duogameswon, duogamesplayed, sologameswon, sologamesplayed, totalgamesplayed, duoers];
}

/** Returns a timestamp for the given epoch **/
function getTimeStamp(time)
{
	today = new Date(time);
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

/** returns the name of the champ with the given ID **/
function getChampFromId(id) {
	return Object.keys(champjson.data).filter( c => {
		return parseInt(champjson.data[c].key) == id;
	})[0];
}

async function main() {	
	await getmatchhistory(soloduoqueue);
	for (let x=0; x < matchhistory.length; x++) {
		await getMatchInfo(matchhistory[x]);
	}
	for (let y=0; y< matchhistory.length; y++) {
		analyzeMatch(matchhistory[y]);
	}
	finalanalysis(3);
}

//main();

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

    //the lookup bot: !User [region] [name] ie !user na hugs
    if (receivedMessage.content.search(/^!duo/i) > -1)
    {
        onMessage.lookupName(receivedMessage);
        return;
    }
});


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
            game = `TV (Free to handle requests)    Help command: !duo help`;
            client.user.setActivity(game, { type: `WATCHING`});
    	}
    },
    async getReady() {
    	await loadChamps();
   		await getCache();
    }
}

const onMessage =  {
	async lookupName(receivedMessage)
    {
        message = receivedMessage.content;
        summonerName = ``;
        //use regex to find the region and summoner name
        let region = message.match(/(?<=!duo )[\w]+/i)
        if (!region || region.length != 1)
        {
            receivedMessage.react(xmark);
            return false;
        }
        region = region[0].toLowerCase();
        if (region == "help") {
        	onMessage.help(receivedMessage);
        	return;
        } else if (!Object.keys(regionendpoint).includes(region))
        {
            receivedMessage.react(xmark);
            return false;
        }
        region = regionendpoint[region];
        let reg = /(?<=!duo [\w]+ )[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿąćęıłńœśšźżžƒÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞŸĄĆĘIŁŃŒŚŠŹŻŽªºßˆˇˉﬁﬂµμ\w\d\s]+/i
        summonerName = message.match(reg)
        if (!summonerName || summonerName.length != 1)
        {
            receivedMessage.react(xmark);
            return false;
        }
        summonerName = summonerName[0].toLowerCase();
        if (summonerName.length > 16 || summonerName.length < 3)
        {
            receivedMessage.react(xmark);
            return false;
        }
        globalReplyMessage = `Searching for summoner name: '${summonerName}'`;
        globalReplyMessage += ` on the ${region} server...`;
        receivedMessage.channel.send(globalReplyMessage)
        .then(async (message) => {
        	let matchhistory = [];
        	let sentMessage  = message;
        	joinQueue();
        	let ids = await getID(summonerName, region);
        	if (ids.length != 2) {
        		message.edit(`Error finding this summoner and region combination.`);
        		leaveQueue();
        		return;
        	}
        	let accountid = ids[0];
        	let summonerid = ids[1];
        	solom = await getmatchhistory(soloduoqueue, region, accountid);
        	flexm = await getmatchhistory(flexqueue, region, accountid);
        	matchhistory = matchhistory.concat(solom);
        	matchhistory = matchhistory.concat(flexm);
        	if (matchhistory == null || matchhistory.length == 0) {
        		message.edit(`No matches found.`);
        		leaveQueue();
        		return;
        	} else {
        		message.edit(`Summoner found. Updating matches... (this might take a while)`);
        	}
        	//now api search the matches
        	for (let x=0; x < matchhistory.length; x++) {
        		await getMatchInfo(matchhistory[x], region);
        	}
        	let teammates = {};
        	for (let y=0; y< matchhistory.length; y++) {
				teammates = analyzeMatch(matchhistory[y], teammates, accountid);
			}
			finalarr = finalanalysis(threshold, teammates, matchhistory, accountid);
			//finalarr is [duos won, duos played, solos won, solos played, total played, duoers object]
			let duowr = finalarr[0]/finalarr[1]*100;
			let solowr = finalarr[2]/finalarr[3]*100;
			globalReplyMessage = `Total found games: ${finalarr[4]}. \nGames with a duo: ${finalarr[1]}, won ${finalarr[0]}, Winrate: ${duowr.toFixed(2)}% \n`;
			globalReplyMessage += `Games without a duo: ${finalarr[3]}, won ${finalarr[2]}, Winrate: ${solowr.toFixed(2)}% \n Duos found: `;
			Object.keys(finalarr[5]).forEach(key => {
				//console.log(finalarr[5])
				//console.log(key)
				//console.log(finalarr[5][key])
				globalReplyMessage += `${key}: ${finalarr[5][key][0]}-${finalarr[5][key][1]-finalarr[5][key][0]}.  `;
			});
			message.edit(globalReplyMessage);
			leaveQueue();
        })
    },
    help(receivedMessage) {
    	globalReplyMessage = `Hi, I'm DuoBot.  If you would like to search your summoner, please use the following command: \n`;
    	globalReplyMessage += `!duo [region] [summoner]  (as an example: !duo na albert471)\n`;
    	globalReplyMessage += `have questions, feedback, or a bug to report? Message me at APotS#8566 or join <https://discord.gg/zdAajBZ>.`;
    	receivedMessage.channel.send(globalReplyMessage);
    }
}

/** Handles number of active threads. When count is 0, status changs to "not busy". **/
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