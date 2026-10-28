using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

/// <summary>Installation-private vault. Public machine views contain references, never passwords.</summary>
public sealed partial class ControlStore
{
    private void InitializeSshCredentials() => Execute("""
        CREATE TABLE IF NOT EXISTS ssh_credentials(id TEXT PRIMARY KEY,username TEXT NOT NULL,label TEXT NOT NULL,cipher TEXT NOT NULL,version TEXT NOT NULL,updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ssh_machines(id TEXT PRIMARY KEY,connector_id TEXT NOT NULL,payload TEXT NOT NULL);
        """);
    private byte[] SshVaultKey => HMACSHA256.HashData(Encoding.UTF8.GetBytes(secrets.RunSecret),Encoding.UTF8.GetBytes("AgenticView SSH credential vault v1"));
    private string ProtectSshPassword(string id,string password)
    {
        var nonce=RandomNumberGenerator.GetBytes(12); var plain=Encoding.UTF8.GetBytes(password); var cipher=new byte[plain.Length]; var tag=new byte[16]; var key=SshVaultKey;
        try { using var aes=new AesGcm(key,16); aes.Encrypt(nonce,plain,cipher,tag,Encoding.UTF8.GetBytes(id)); return Convert.ToBase64String(nonce.Concat(tag).Concat(cipher).ToArray()); }
        finally { CryptographicOperations.ZeroMemory(plain); CryptographicOperations.ZeroMemory(key); }
    }
    private string UnprotectSshPassword(string id,string value)
    {
        var bytes=Convert.FromBase64String(value); var plain=new byte[bytes.Length-28]; var key=SshVaultKey;
        try { using var aes=new AesGcm(key,16); aes.Decrypt(bytes.AsSpan(0,12),bytes.AsSpan(28),bytes.AsSpan(12,16),plain,Encoding.UTF8.GetBytes(id)); return Encoding.UTF8.GetString(plain); }
        finally { CryptographicOperations.ZeroMemory(plain); CryptographicOperations.ZeroMemory(key); }
    }
    public JsonObject SshMachines()
    {
        lock(gate) { var machines=new JsonArray(); using(var c=Command("SELECT payload FROM ssh_machines ORDER BY id LIMIT 256")) using(var r=c.ExecuteReader()) while(r.Read()) machines.Add(Parse(r.GetString(0)));
            var credentials=new JsonArray(); using(var c=Command("SELECT id,username,label,version,updated FROM ssh_credentials ORDER BY updated DESC LIMIT 256")) using(var r=c.ExecuteReader()) while(r.Read()) credentials.Add(Json.Object(new{id=r.GetString(0),username=r.GetString(1),label=r.GetString(2),version=r.GetString(3),updatedAt=r.GetInt64(4)}));
            return Json.Object(new{machines,credentials}); }
    }
    public JsonObject SaveSshMachine(JsonObject input)
    {
        Budget(input,32768); var id=ComponentValidator.Id(input,"id"); var label=ComponentValidator.Text(input,"label",160,true,1); var host=ComponentValidator.Text(input,"host",253,true,1); var connectorId=ComponentValidator.Id(input,"connectorId"); var port=input.ContainsKey("port")?(int)ComponentValidator.Number(input,"port",1,65535,true,true):22;
        if(host.StartsWith('-') || host.Any(c=>!char.IsAsciiLetterOrDigit(c) && c is not ('.' or '-' or '_' or ':' or '[' or ']'))) throw new HubError(400,"SSH host must be a host name, address or local SSH alias; keep the account separate.");
        lock(gate) {
            var old=Scalar("SELECT payload FROM ssh_machines WHERE id=$p0",id) as string;
            if(old is null && Convert.ToInt64(Scalar("SELECT COUNT(*) FROM ssh_machines"))>=256) throw new HubError(429,"SSH machine capacity reached.");
            var credentialId=ComponentValidator.Id(input,"credentialId",false); string username,version,credentialLabel;
            var password=ComponentValidator.Text(input,"password",8192,false);
            if(password.IndexOfAny(['\r','\n','\0'])>=0) throw new HubError(400,"SSH passwords cannot contain line breaks or NUL.");
            var authentication=input.ContainsKey("authentication")?ComponentValidator.Text(input,"authentication",20):"password";
            if(authentication is not ("password" or "agent")) throw new HubError(400,"Unsupported SSH authentication mode.");
            if(authentication=="agent") { credentialId=""; username=ComponentValidator.Text(input,"username",256,false); if(username.StartsWith('-') || username.Any(char.IsControl)) throw new HubError(400,"Invalid SSH account."); version=Guid.NewGuid().ToString(); credentialLabel="Existing SSH agent / configuration"; }
            else if(password.Length>0) {
                username=ComponentValidator.Text(input,"username",256,true,1); if(username.StartsWith('-') || username.Any(char.IsControl)) throw new HubError(400,"Invalid SSH account.");
                credentialId=Guid.NewGuid().ToString(); version=Guid.NewGuid().ToString(); credentialLabel=ComponentValidator.Text(input,"credentialLabel",160,false); if(credentialLabel.Length==0) credentialLabel=label+" account";
                if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM ssh_credentials"))>=256) throw new HubError(429,"Saved account capacity reached. Remove unused credentials first.");
                Execute("INSERT INTO ssh_credentials VALUES($p0,$p1,$p2,$p3,$p4,$p5)",credentialId,username,credentialLabel,ProtectSshPassword(credentialId,password),version,Now);
            } else if(credentialId.Length>0) {
                using var c=Command("SELECT username,label,version FROM ssh_credentials WHERE id=$p0",credentialId); using var r=c.ExecuteReader(); if(!r.Read()) throw new HubError(404,"Saved account unavailable."); username=r.GetString(0); credentialLabel=r.GetString(1); version=r.GetString(2);
            } else throw new HubError(400,"Choose a saved account or enter a username and password.");
            var machine=Json.Object(new{id,label,host,port,connectorId,authentication,credentialId,credentialLabel,credentialVersion=version,username,valid=true,updatedAt=Now});
            Execute("INSERT INTO ssh_machines VALUES($p0,$p1,$p2) ON CONFLICT(id) DO UPDATE SET connector_id=excluded.connector_id,payload=excluded.payload",id,connectorId,Json.Text(machine));
            return machine;
        }
    }
    public JsonObject RemoveSshCredential(string id)
    {
        lock(gate) {
            var machines=new List<JsonObject>(); using(var c=Command("SELECT payload FROM ssh_machines")) using(var r=c.ExecuteReader()) while(r.Read()) { var m=Parse(r.GetString(0)); if(Text(m,"credentialId")==id) machines.Add(m); }
            foreach(var machine in machines) { machine["valid"]=false; machine["message"]="Saved account removed. Enter replacement credentials."; Execute("UPDATE ssh_machines SET payload=$p1 WHERE id=$p0",Text(machine,"id"),Json.Text(machine)); }
            Execute("DELETE FROM ssh_credentials WHERE id=$p0",id); return Json.Object(new{removed=true});
        }
    }
    public JsonObject AcquireSshCredential(string connectorId,string token,string machineId,JsonObject input)
    {
        Budget(input,16384); lock(gate) {
            ConnectorAuth(connectorId,token); var machine=Scalar("SELECT payload FROM ssh_machines WHERE id=$p0 AND connector_id=$p1",machineId,connectorId) is string payload ? Parse(payload) : throw new HubError(403,"SSH machine is not assigned to this connector.");
            if(!ComponentValidator.Boolean(machine,"valid")) throw new HubError(409,"SSH credentials require replacement in Settings → SSH machines.");
            if(input.ContainsKey("host") && (!string.Equals(Text(machine,"host"),ComponentValidator.Text(input,"host",253),StringComparison.OrdinalIgnoreCase) || machine["port"]!.GetValue<int>()!=(input.ContainsKey("port")?(int)ComponentValidator.Number(input,"port",1,65535,true,true):22))) throw new HubError(409,"Configured SSH destination differs from its saved machine. Review the local profile.");
            var credentialId=Text(machine,"credentialId"); var password="";
            if(Text(machine,"authentication")!="agent") { var cipher=Scalar("SELECT cipher FROM ssh_credentials WHERE id=$p0",credentialId) as string ?? throw new HubError(409,"Saved SSH account is unavailable."); password=UnprotectSshPassword(credentialId,cipher); }
            return Json.Object(new{machineId,host=Text(machine,"host"),port=machine["port"]!.GetValue<int>(),username=Text(machine,"username"),password,credentialVersion=Text(machine,"credentialVersion")});
        }
    }
    public JsonObject RejectSshCredential(string connectorId,string token,string machineId,JsonObject input)
    {
        Budget(input,16384); lock(gate) {
            ConnectorAuth(connectorId,token); var machine=Scalar("SELECT payload FROM ssh_machines WHERE id=$p0 AND connector_id=$p1",machineId,connectorId) is string payload ? Parse(payload) : throw new HubError(403,"SSH machine is not assigned to this connector.");
            if(Text(machine,"credentialVersion")==ComponentValidator.Text(input,"credentialVersion",100)) { machine["valid"]=false; machine["message"]="SSH rejected this account. Enter replacement credentials. Other machine bindings remain unchanged."; machine["updatedAt"]=Now; Execute("UPDATE ssh_machines SET payload=$p1 WHERE id=$p0",machineId,Json.Text(machine)); }
            return Json.Object(new{invalidated=!ComponentValidator.Boolean(machine,"valid")});
        }
    }
}
