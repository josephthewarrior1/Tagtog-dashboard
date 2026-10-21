import java.io.BufferedReader;
import java.io.InputStreamReader;
import org.springframework.security.crypto.bcrypt.BCrypt;

// Explicitly generated disposable fixture passwords only. Never guesses real passwords.
class LegacyPasswordFixture {
  public static void main(String[] args) throws Exception {
    var reader = new BufferedReader(new InputStreamReader(System.in));
    var password = reader.readLine();
    if (password == null || !password.matches("[A-Za-z0-9_-]{43}"))
      throw new IllegalArgumentException("A generated disposable fixture password is required");
    if (args.length == 1 && args[0].equals("check")) {
      var hash = reader.readLine();
      if (hash == null || hash.length() != 60) throw new IllegalArgumentException("Fixture hash required");
      System.out.print(BCrypt.checkpw(password, hash));
    } else if (args.length == 0) {
      System.out.print(BCrypt.hashpw(password, BCrypt.gensalt(10)));
    } else throw new IllegalArgumentException("Unsupported fixture operation");
  }
}
