import fetch from "node-fetch";
import hjson from "hjson";
import fs from "fs";
import detectIndent from "detect-indent";

let polling_interval = 15; // seconds
let instances;
try {
   let instances_string = fs.readFileSync("./instances.json", "utf-8");
   try {
      instances = JSON.parse(instances_string);
   }catch(e) {
      console.log("Failed to parse json data from instances.json.");
      console.log(e);
      process.exit();
   }
}catch(e) {
   console.log("instances.json could not be found.");
   process.exit();
}

async function TestInstance(instance) {
   let config_exists = fs.existsSync(instance.config);
   if (!config_exists) return "no_config";

   try {
      let req = await fetch(`http://${instance.ip || "127.0.0.1"}:${instance.port}/api/v1/status`, {
         headers: {
            "Authorization": `Basic ${Buffer.from(instance.user + ":" + instance.pass).toString("base64")}`
         }
      });
      if (req.status === 200) return "api_ok";
      if (req.status === 401) return "auth_fail";
   }catch(e) {
      return "api_refused";
   }
}

async function GetDelistTokens() {
   let tokens = [];
   try {
      let req = await fetch("https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=30");
      let news = await req.json();
      let catalogs = news.data.catalogs;
      for (let i = 0; i < catalogs.length; i++) {
         let catalog = catalogs[i];
         for (let j = 0; j < catalog.articles.length; j++) {
            let article = catalog.articles[j];
            if (article.title.toLowerCase().includes("binance will delist")) {
               // console.log(`${catalog.catalogName}: ${article.title}`);
               let article_tokens = article.title.toUpperCase().split("BINANCE WILL DELIST")[1].split(" ON ")[0].replace("AND", ",").split(/,|&/).map(elem => elem.trim());
			   
			   let block_pairs = [];
			   for (let i = 0; i < article_tokens.length; i++) {
					if(article_tokens[i] && article_tokens[i].length <= 5){
						console.log(`GetDelistToken() -> push: ${article_tokens[i]}`);
						block_pairs.push(article_tokens[i]);
					}
			   }
               tokens.push(...block_pairs);
            }
			
	    if (article.title.toLowerCase().includes("binance margin will delist")) {
               // console.log(`${catalog.catalogName}: ${article.title}`);
               let article_tokens = article.title.toUpperCase().split("BINANCE MARGIN WILL DELIST")[1].split(" ON ")[0].replace("AND", ",").split(/,|&/).map(elem => elem.trim());
			   
			   let block_pairs = [];
			   for (let i = 0; i < article_tokens.length; i++) {
					if(article_tokens[i] && article_tokens[i].length < 5){
						console.log(`GetDelistToken() -> push: ${article_tokens[i]}`);
						block_pairs.push(article_tokens[i]);
					}
			   }
               tokens.push(...block_pairs);
            }
         }
      }
   }catch(e) {
      console.log("Failed to get article list.");
      console.log(e);
   }
   return tokens;
}

async function GetBlacklist(instance) {
   let blacklist;
   try {
      let req = await fetch(`http://${instance.ip || "127.0.0.1"}:${instance.port}/api/v1/blacklist`, {
         headers: {
            "Authorization": `Basic ${Buffer.from(instance.user + ":" + instance.pass).toString("base64")}`
         }
      });
      blacklist = (await req.json()).blacklist;
   }catch(e) {
      console.log(`Failed to get blacklist for instance at ${instance.ip || "127.0.0.1"}:${instance.port}.`);
      console.log(e);
   }
   return blacklist;
}

async function BlacklistPair(instance, pair) {
   console.log(`Blacklisting ${pair} for instance at ${instance.ip || "127.0.0.1"}:${instance.port}.`);
   try{
      fetch(`http://${instance.ip || "127.0.0.1"}:${instance.port}/api/v1/blacklist`, {
         method: "POST",
         headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${Buffer.from(instance.user + ":" + instance.pass).toString("base64")}`
         },
         body: JSON.stringify({blacklist: [pair]})
      });
   }catch(e) {
      console.log(`Failed to blacklist ${pair} for instance at ${instance.ip || "127.0.0.1"}:${instance.port}.`);
      console.log(e);
   }

   console.log(`Blacklisting ${pair} in config ${instance.config}.`);
   try {
      let config_str = fs.readFileSync(instance.config, "utf-8");
      try {
         let config = hjson.parse(config_str, {keepWsc: true});
         let indent = detectIndent(config_str).amount;
         if (!config.exchange.pair_blacklist.includes(pair)) {
            try {
               config.exchange.pair_blacklist.push(pair);
            }catch(e) {
               console.log(`Failed to blacklist ${pair} in config file at ${instance.config}`);
               console.log(e);
            }
            try {
               fs.writeFileSync(instance.config, hjson.stringify(config, {keepWsc: true, bracesSameLine: true, quotes: "all", space: indent, separator: true}));
            }catch(e) {
               console.log(`Failed to save config file at ${instance.config}`);
            }
         }
      }catch(e) {
         console.log(`Failed to parse config file at ${instance.config}`);
         console.log(e);
      }
   }catch(e) {
      console.log(`Failed to load config file at ${instance.config}.`);
      console.log(e);
   }
}

async function Loop() {
   console.log("Checking for delisted tokens...");
   let blacklisted_tokens = [];
   let tokens = await GetDelistTokens();
   for (let i = 0; i < instances.length; i++) {
      let blacklist = await GetBlacklist(instances[i]);
      if (!blacklist) continue;
      let tokens_not_blacklisted = tokens.filter(token => !blacklist.map(bl_pair => bl_pair.split("/")[0].toUpperCase()).includes(token));
      for (let j = 0; j < tokens_not_blacklisted.length; j++) {
         await BlacklistPair(instances[i], `${tokens_not_blacklisted[j]}/.*`);
         blacklisted_tokens.push(tokens_not_blacklisted[j]);
      }
   }
   blacklisted_tokens = [...new Set(blacklisted_tokens)];
   if (blacklisted_tokens.length !== 0) {
      console.log(`Blacklisted ${blacklisted_tokens.length} tokens.`);
   }
}

(async () => {
   for (let i = 0; i < instances.length; i++) {
      let test_result = await TestInstance(instances[i]);
      if (test_result === "auth_fail") {
         console.log(`Instance at ${instances[i].ip || "127.0.0.1"}:${instances[i].port} failed authentication. Check if the username and password is correct.`);
         process.exit();
      }
      if (test_result === "api_refused") {
         console.log(`Instance at ${instances[i].ip || "127.0.0.1"}:${instances[i].port} could not connect. Is the bot running?`);
         process.exit();
      }
      if (test_result === "no_config") {
         console.log(`Config at ${instances[i].config} could not be found.`);
         process.exit();
      }
      console.log(`Config file at ${instances[i].config} and connection to instance at ${instances[i].ip || "127.0.0.1"}:${instances[i].port} looks OK!`);
   }
   Loop();
   setInterval(Loop, polling_interval * 1000);
})();
