-- Create table for storing user GitHub tokens
CREATE TABLE IF NOT EXISTS user_github_tokens (
  discord_user_id TEXT PRIMARY KEY,
  github_token TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_github_tokens_discord_user_id ON user_github_tokens(discord_user_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_user_github_tokens_updated_at
  BEFORE UPDATE ON user_github_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

