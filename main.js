//=====================================================================================    
//=====================================================================================
//                                  DuoBot.js
// * Basic discord bot written in Javascript (Discord.js)
// * When prompted, calculates duo and solo winrate for a given summoner
// * @author: Albert471
// * @version: 1.1.6
//=====================================================================================

//todo:  add more features, bug test concurrency/other regions/edge cases/error cases/caching
// if you want: change the way it stores players to acccount for name changes
// revamp caching system by rewriting object to store less info (maybe a second file)

/** API related variables **/
const api = ""; //Riot API key
const disctoken = ``; //Discord Token

/** Libraries the bot requires **/
const Discord = require(`discord.js`);
const client = new Discord.Client();
client.login(disctoken);
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
};

/** League API-specific global variables **/
const seasonsstartepoch = 1578488400000; //start of season 10
const clashqueue = 700;
const flexqueue = 440;
const soloduoqueue = 420;

/** Other global variables **/
let champjson = {};
let matchcache = {};
let globalReplyMessage = ``;
let threshold = 3;
let queue = 0; //number of items in queue

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
		console.log(err);
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
		});
}

/** calculates teammates and adds them to the teammates object. **/
function analyzeMatch(matchid, teammates, accountid) {
	if (!matchcache[matchid]) {
		return teammates;
	}
	if (matchcache[matchid].gameDuration < 300) {
		return teammates;
	}
	//find participantid of analyzed player by matching accountId
	const partId = matchcache[matchid].participantIdentities;
	let foundId = partId.find(p => {
		return p.player.accountId == accountid;
	}).participantId;
	//find team of summoner
	const part = matchcache[matchid].participants;
	let teamId = part.find(pl => {
		return pl.participantId == foundId;
	}).teamId;
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
			return pl.participantId == teammatepid && pl.player.accountId != accountid;
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
function getWinOrLoss(matchid, accountid) {
	if (!matchid in matchcache) return;
	// get participantid of searched player
	const partId = matchcache[matchid].participantIdentities;
	let foundId = partId.find(p => {
		return p.player.accountId == accountid;
	}).participantId;
	// get participant from participantid
	const part = matchcache[matchid].participants;
	return part.find(pl => {
		return pl.participantId == foundId;
	}).stats.win;
}

/** returns true if the two matches have the same queue.  soft errors if it doesn't exist */
function compareQueues(matchid1, matchid2) {
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
	for (let x=0; x<allplayers.length; x++) {
		if (teammates[allplayers[x]].length >= threshold) {
			duogames = duogames.concat(teammates[allplayers[x]]);
		}
	}
	let duogamesUnique = duogames.filter(function(elem, pos) {
    	return duogames.indexOf(elem) == pos;
    });
    for (let y=0; y<duogamesUnique.length; y++) {
    	if (getWinOrLoss(duogamesUnique[y], accountid)) {
    		duogameswon++;
    	}
    }
    //filter out remake games from matchhistory
    let matchtemp = matchhistory.filter(m => {
    	return matchcache[m].gameDuration > 300;
    });
    matchhistory = matchtemp;

    let sologames = [];
    let sologameswon = 0;
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
    	let counter = 0;
    	for (let b=0; b<duoers[key].length; b++) {
    		if (getWinOrLoss(duoers[key][b], accountid)) {
    			counter++;
    		}
    	}
    	duoers[key] = [counter, duoers[key].length];
    });

    let totalgamesplayed = matchhistory.length;
    let duogamesplayed = duogamesUnique.length;
    let sologamesplayed = sologames.length;
    totalgamesplayed = sologamesplayed + duogamesplayed;
    return [duogameswon, duogamesplayed, sologameswon, sologamesplayed, totalgamesplayed, duoers];
}

/** Returns a timestamp for the given epoch **/
function getTimeStamp(time)
{
	let today = new Date(time);
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
function insertionSort(array) {
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

/** create and return the boilerplate of an embed for SummonerName. */
/** afterwards, you need to add fields and the description */
function createEmbed(summonerName, description) {
	let color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
	const embed = new Discord.MessageEmbed()
		.setColor(color)
		.setTitle(summonerName)
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
	    onMessage.lookupMsg(receivedMessage);
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
            let game = `TV (Free to handle requests)    Help command: !duo help`;
            client.user.setActivity(game, { type: `WATCHING`});
    	}
    },
    async getReady() {
    	await loadChamps();
   		await getCache();
   		console.log(`cachesize: ${Object.keys(matchcache).length}`);
    }
};

const onMessage =  {
	async losers(receivedMessage, matchhistory, accountid, sentmsg, summonerName) {
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
				let queuecheck = x < matchhistory.length - 1 ? compareQueues(matchhistory[x], matchhistory[x+1]) : true;
				if (matchcache[matchhistory[x]].gameDuration <= 300) {
					remakecount++;
					continue;
				}
				let wonThisOne = getWinOrLoss(matchhistory[x], accountid);
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
		const embed = createEmbed(summonerName,'Calculated Loss Streak Information');
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
		sentmsg.edit(`Loss Streak Statistics for ${summonerName}.`);
		sentmsg.edit(embed);

	},
	async duo(receivedMessage, matchhistory, accountid, sentmsg, summonerName) {
    	let teammates = {};
    	for (let y=0; y < matchhistory.length; y++) {
			teammates = analyzeMatch(matchhistory[y], teammates, accountid);
		}
		let finalarr = finalanalysis(threshold, teammates, matchhistory, accountid);
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
		const embed = createEmbed(summonerName, `Calculated Duo Information`);
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
		if (duoSorted.length > 18) {
			let lastline = "";
			for (let x=18; x<duoSorted.length; x++) {
				let duoArray = finalarr[5][duoSorted[x]];
				lastline += `**${duoSorted[x]}:** ${duoArray[0]}-${duoArray[1]-duoArray[0]}\n`;
			}
			embed.addField('Other Duos:', lastline, false);
		}
		sentmsg.edit(`Duo Statistics for ${summonerName}.`);
		sentmsg.edit(embed);
	},
	async lookupMsg(receivedMessage)
    {
        let message = receivedMessage.content;
        let summonerName = ``;
        //use regex to find the region and summoner name
        let region = message.match(/(?<=!duo |!duolosers )[\w]+/i);
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
        let reg = /(?<=!duo [\w]+ |!duolosers [\w]+ )[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿąćęıłńœśšźżžƒÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞŸĄĆĘIŁŃŒŚŠŹŻŽªºßˆˇˉﬁﬂµμ\w\d\s]+/i;
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
        globalReplyMessage = `Searching for summoner name: '${summonerName}'`;
        globalReplyMessage += ` on the ${region} server...`;
        receivedMessage.channel.send(globalReplyMessage)
        .then(async (message) => {
        	let matchhistory = [];
        	joinQueue();
        	let ids = await getID(summonerName, region);
        	if (ids.length != 2) {
        		message.edit(`Error finding this summoner and region combination.`);
        		leaveQueue();
        		return;
        	}
        	let accountid = ids[0];
        	let summonerid = ids[1];
        	let solom = await getmatchhistory(soloduoqueue, region, accountid);
        	solom = insertionSort(solom);
        	let flexm = await getmatchhistory(flexqueue, region, accountid);
        	flexm = insertionSort(flexm);
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
        		//progress bar every 100 matches (and a quick one at 10 to check for ratelimit)
        		if (x%100 == 0 || x==10) {
        			message.edit(`Summoner found. Updating matches... (this might take a while)\n Progress: ${x}/${matchhistory.length}.`);
        		}
        	}

        	//send the matches off to the correct analysis function
        	if (receivedMessage.content.search(/^!duo /i) > -1) {
        		onMessage.duo(receivedMessage, matchhistory, accountid, message, summonerName);
        	} else if (receivedMessage.content.search(/^!duolosers /i) > -1) {
        		onMessage.losers(receivedMessage, matchhistory, accountid, message, summonerName);
        	} else {
        		message.react(xmark);
        	}
        	leaveQueue();
        });
    },
    help(receivedMessage) {
    	globalReplyMessage = `Hi, I'm DuoBot.  If you would like to search your summoner, please use the following command: \n`;
    	globalReplyMessage += `!duo [region] [summoner]  (as an example: !duo na albert471)\n`;
    	globalReplyMessage += `have questions, feedback, or a bug to report? Message me at APotS#8566 or join <https://discord.gg/zdAajBZ>.`;
    	receivedMessage.channel.send(globalReplyMessage);
    }
};

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