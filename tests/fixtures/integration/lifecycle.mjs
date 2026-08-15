const stage = process.argv[2] ?? "test";
if (!["provision", "ready", "test", "cleanup"].includes(stage)) process.exit(2);
console.log(JSON.stringify({ stage, status: "PASS", ephemeral: true }));
